import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/http';
import {
  checkBundle, createVersion, HOSTED_LIMITS, listVersions, parseMcpJson, publishVersion, retireVersion, setHostedSecrets,
  startDeploy, syncVersion, type DeployState, type HostedSpriteOps, type HostedVersion,
} from '@/lib/services/hosted-mcp';
import { createProject, deleteOwnProject, hireAgent } from '@/lib/services/projects';
import { createTemplate, publishTemplate, updateTemplate } from '@/lib/services/templates';
import { seedUser, testDb } from './helpers';

const db = testDb();

async function expectStatus(p: Promise<unknown>, status: number, message?: string) {
  const e = await p.then(() => { throw new Error('應該失敗'); }, (err) => err);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
  if (message) expect((e as HttpError).message).toBe(message);
}

async function hostedTemplate(creatorId: string) {
  return createTemplate(db, creatorId, {
    name: '代管顧問', description: '', category: '', system_prompt: 'p',
    mcp_servers: [{ name: 'fin', transport: 'remote', hosted: true, required_secrets: [] }],
  });
}

async function insertVersion(templateId: string, version: number, status: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await db.from('hosted_mcp_versions')
    .insert({ template_id: templateId, mcp_name: 'fin', version, status, bundle_path: `${templateId}/fin/${version}.zip`, ...extra })
    .select('id').single();
  if (error) throw error;
  return data.id as string;
}

async function readVersion(id: string): Promise<HostedVersion> {
  const { data, error } = await db.from('hosted_mcp_versions').select('*').eq('id', id).single();
  if (error) throw error;
  return data as HostedVersion;
}

function fakeSprites(state: DeployState = { phase: 'installing', log: 'pip install' }) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ops: HostedSpriteOps & {
    state: DeployState; tools: { name: string; description?: string }[];
    provisionDelayMs: number; provisionError: Error | null; listToolsError: Error | null;
  } = {
    state,
    tools: [{ name: 'rate', description: '匯率' }],
    provisionDelayMs: 0,
    provisionError: null as Error | null,
    listToolsError: null as Error | null,
    async provision(v: HostedVersion, env: Record<string, string>, bundleUrl: string) {
      calls.push({ fn: 'provision', args: [v.id, env, bundleUrl] });
      if (ops.provisionDelayMs) await new Promise((r) => setTimeout(r, ops.provisionDelayMs));
      if (ops.provisionError) throw ops.provisionError;
      return { spriteName: `agenthub-mcp-${v.id.replace(/-/g, '').slice(0, 12)}`, spriteUrl: 'https://fake-mcp.sprites.app' };
    },
    async readState(name: string) { calls.push({ fn: 'readState', args: [name] }); return ops.state; },
    async startService(name: string, start: string) { calls.push({ fn: 'startService', args: [name, start] }); },
    async listTools(url: string, token: string) {
      calls.push({ fn: 'listTools', args: [url, token] });
      if (ops.listToolsError) throw ops.listToolsError;
      return ops.tools;
    },
    async serviceLog(name: string) { calls.push({ fn: 'serviceLog', args: [name] }); return 'ModuleNotFoundError: No module named requests'; },
    async applyEnv(name: string, env: Record<string, string>) { calls.push({ fn: 'applyEnv', args: [name, env] }); },
    async destroy(name: string) { calls.push({ fn: 'destroy', args: [name] }); },
  };
  return { ops, calls };
}

describe('平台代管 MCP：上架與租用', () => {
  it('沒有已發布版本不能上架；有了就可以', async () => {
    const creator = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    await expectStatus(publishTemplate(db, creator.id, t.id), 400, 'MCP「fin」還沒有已發布的版本');
    await insertVersion(t.id, 1, 'ready');
    await expectStatus(publishTemplate(db, creator.id, t.id), 400, 'MCP「fin」還沒有已發布的版本');
    await insertVersion(t.id, 2, 'published');
    expect((await publishTemplate(db, creator.id, t.id)).status).toBe('published');
  });

  it('已上架但版本都下架了：租用回 409', async () => {
    const creator = await seedUser(db);
    const renter = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    const v = await insertVersion(t.id, 1, 'published');
    await publishTemplate(db, creator.id, t.id);
    await db.from('hosted_mcp_versions').update({ status: 'retired' }).eq('id', v);
    const p = await createProject(db, renter.id, 'p');
    await expectStatus(hireAgent(db, renter.id, p.id, t.id, {}), 409, '這位顧問的工具服務尚未發布');
  });
});

describe('parseMcpJson、checkBundle', () => {
  it('只接受 python／node 與非空的 start', () => {
    expect(parseMcpJson('{"runtime":"python","start":"python server.py","install":"requirements.txt"}'))
      .toEqual({ runtime: 'python', start: 'python server.py', install: 'requirements.txt' });
    expect(parseMcpJson('{"runtime":"node","start":"node index.js"}')).toEqual({ runtime: 'node', start: 'node index.js' });
    expect(() => parseMcpJson('{"runtime":"ruby","start":"x"}')).toThrow('runtime');
    expect(() => parseMcpJson('{"runtime":"python","start":" "}')).toThrow('start');
    expect(() => parseMcpJson('not json')).toThrow('mcp.json');
  });

  it('套件超過 50 MB 或讀不到大小：400', () => {
    expect(() => checkBundle(HOSTED_LIMITS.bundleBytes)).not.toThrow();
    expect(() => checkBundle(HOSTED_LIMITS.bundleBytes + 1)).toThrow(HttpError);
    expect(() => checkBundle(undefined)).toThrow(HttpError);
  });
});

describe('代管版本：建立與部署', () => {
  it('不是自己的範本 404；不是代管的 MCP 400', async () => {
    const creator = await seedUser(db);
    const other = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    await expectStatus(createVersion(db, other.id, t.id, 'fin'), 404);
    await expectStatus(createVersion(db, creator.id, t.id, 'nope'), 400, '這個 MCP 不是平台代管');
  });

  it('版本號遞增；上傳後才能部署；部署中不能再建', async () => {
    const creator = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    const { version: v1, signedUrl } = await createVersion(db, creator.id, t.id, 'fin');
    expect(v1).toMatchObject({ version: 1, status: 'pending', bundle_path: `${t.id}/fin/1.zip` });
    await expectStatus(createVersion(db, creator.id, t.id, 'fin'), 409, '已有版本正在部署');
    await expectStatus(startDeploy(db, creator.id, v1.id), 400, '還沒有上傳套件');

    const zip = new Blob([new Uint8Array([80, 75, 5, 6])]);
    const res = await fetch(signedUrl, { method: 'PUT', body: zip, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
    expect(res.ok).toBe(true);
    const deploying = await startDeploy(db, creator.id, v1.id);
    expect(deploying.status).toBe('deploying');
    expect(deploying.deploy_started_at).not.toBeNull();
    await expectStatus(startDeploy(db, creator.id, v1.id), 409);

    await db.from('hosted_mcp_versions').update({ status: 'failed' }).eq('id', v1.id);
    expect((await createVersion(db, creator.id, t.id, 'fin')).version.version).toBe(2);
    expect((await listVersions(db, creator.id, t.id, 'fin')).map((v) => v.version)).toEqual([2, 1]);
  });

  it('已發布 3 個版本：409', async () => {
    const creator = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    for (const n of [1, 2, 3]) await insertVersion(t.id, n, 'published');
    await expectStatus(createVersion(db, creator.id, t.id, 'fin'), 409, '已發布 3 個版本，請先下架沒有專案使用的舊版本');
  });

  it('創作者的代管 Sprite 已有 10 台：409（retired 與沒有 Sprite 的不算）', async () => {
    const creator = await seedUser(db);
    const full = await hostedTemplate(creator.id);
    for (let n = 1; n <= 9; n++) await insertVersion(full.id, n, 'failed', { sprite_name: `agenthub-mcp-x${n}` });
    await insertVersion(full.id, 10, 'retired', { sprite_name: 'agenthub-mcp-x10' });
    await insertVersion(full.id, 11, 'failed');
    const t = await hostedTemplate(creator.id);
    await createVersion(db, creator.id, t.id, 'fin');
    await db.from('hosted_mcp_versions').update({ status: 'failed', sprite_name: 'agenthub-mcp-x12' }).eq('template_id', t.id);
    await expectStatus(createVersion(db, creator.id, t.id, 'fin'), 409, '代管 Sprite 已達 10 台上限');
  });
});

describe('代管版本：狀態推進', () => {
  const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  async function deployingVersion(startedAt = new Date().toISOString()) {
    const creator = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    const id = await insertVersion(t.id, 1, 'deploying', { deploy_started_at: startedAt });
    return { creator, t, id };
  }

  it('第一次同步：建立 Sprite，env 含金鑰與平台變數', async () => {
    vi.stubEnv('PLATFORM_URL', 'https://platform.test');
    const { creator, t, id } = await deployingVersion();
    // 正式流程在 startDeploy 前已上傳；這裡直接插入版本，所以自己放一個套件
    const { error } = await db.storage.from('mcp-bundles').upload(`${t.id}/fin/1.zip`, new Uint8Array([80, 75, 5, 6]), { contentType: 'application/zip' });
    if (error) throw error;
    const { ops, calls } = fakeSprites();
    await setHostedSecrets(db, creator.id, t.id, 'fin', { API_KEY: 'k1' }, ops);
    const v = await syncVersion(db, id, ops);
    const [, env, bundleUrl] = calls.find((c) => c.fn === 'provision')!.args as [string, Record<string, string>, string];
    expect(env).toEqual({ API_KEY: 'k1', PORT: '8080', AGENTHUB_PLATFORM_URL: 'https://platform.test' });
    expect(bundleUrl).toContain('mcp-bundles');
    expect(v).toMatchObject({
      status: 'deploying', sprite_name: `agenthub-mcp-${id.replace(/-/g, '').slice(0, 12)}`,
      sprite_url: 'https://fake-mcp.sprites.app', log_tail: 'pip install',
    });
    vi.unstubAllEnvs();
  });

  it('安裝完成：啟動服務、取得工具清單 → ready；沒有工具 → failed', async () => {
    vi.stubEnv('MCP_SIGNING_KEY', pem);
    for (const [tools, status] of [[[{ name: 'rate' }], 'ready'], [[], 'failed']] as const) {
      const { id } = await deployingVersion();
      await db.from('hosted_mcp_versions').update({ sprite_name: 'agenthub-mcp-a', sprite_url: 'https://a.sprites.app' }).eq('id', id);
      const { ops, calls } = fakeSprites({ phase: 'installed', start: 'python server.py', log: 'ok' });
      ops.tools = [...tools];
      const v = await syncVersion(db, id, ops);
      expect(calls.map((c) => c.fn)).toEqual(['readState', 'startService', 'listTools']);
      expect(calls[1].args).toEqual(['agenthub-mcp-a', 'python server.py']);
      expect(calls[2].args[0]).toBe('https://a.sprites.app');
      expect(v.status).toBe(status);
      if (status === 'ready') expect(v.tools).toEqual([{ name: 'rate' }]);
      else expect(v.log_tail).toContain('沒有任何工具');
    }
    vi.unstubAllEnvs();
  });

  it('部署腳本失敗：failed，日誌只留最後 100 行', async () => {
    const { id } = await deployingVersion();
    await db.from('hosted_mcp_versions').update({ sprite_name: 'agenthub-mcp-a', sprite_url: 'https://a.sprites.app' }).eq('id', id);
    const log = Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n');
    const { ops } = fakeSprites({ phase: 'failed', error: '安裝失敗', log });
    const v = await syncVersion(db, id, ops);
    expect(v.status).toBe('failed');
    const lines = v.log_tail.split('\n');
    expect(lines.length).toBeLessThanOrEqual(100);
    expect(lines.at(-1)).toBe('line 149');
    expect(v.log_tail).toContain('安裝失敗');
  });

  it('超過 10 分鐘還在部署：failed「部署逾時」，不再碰 Sprite', async () => {
    const started = Date.now() - HOSTED_LIMITS.deployMs - 1000;
    const { id } = await deployingVersion(new Date(started).toISOString());
    const { ops, calls } = fakeSprites();
    const v = await syncVersion(db, id, ops);
    expect(v.status).toBe('failed');
    expect(v.log_tail).toContain('部署逾時');
    expect(calls).toEqual([]);
  });

  it('程式起不來：維持部署中，日誌附上程式自己的輸出', async () => {
    vi.stubEnv('MCP_SIGNING_KEY', pem);
    const { id } = await deployingVersion();
    await db.from('hosted_mcp_versions').update({ sprite_name: 'agenthub-mcp-a', sprite_url: 'https://a.sprites.app' }).eq('id', id);
    const { ops } = fakeSprites({ phase: 'installed', start: 'python server.py', log: 'ok' });
    ops.listToolsError = new Error('MCP 回應 502');
    const v = await syncVersion(db, id, ops);
    expect(v.status).toBe('deploying');
    expect(v.log_tail).toContain('ModuleNotFoundError');
    expect(v.log_tail).toContain('MCP 回應 502');
    vi.unstubAllEnvs();
  });

  it('同時兩次同步只建立一次 Sprite；建立中的版本不重複建立', async () => {
    const { t, id } = await deployingVersion();
    const { error } = await db.storage.from('mcp-bundles').upload(`${t.id}/fin/1.zip`, new Uint8Array([80, 75, 5, 6]), { contentType: 'application/zip' });
    if (error) throw error;
    const { ops, calls } = fakeSprites();
    ops.provisionDelayMs = 500;
    await Promise.all([syncVersion(db, id, ops), syncVersion(db, id, ops)]);
    expect(calls.filter((c) => c.fn === 'provision')).toHaveLength(1);
    const v = await readVersion(id);
    expect(v.sprite_name).toBe(`agenthub-mcp-${id.replace(/-/g, '').slice(0, 12)}`);
    expect(v.sprite_url).toBe('https://fake-mcp.sprites.app');
  });

  it('建立 Sprite 失敗：failed 並保留 sprite_name，之後清理得到', async () => {
    const { t, id } = await deployingVersion();
    const { error } = await db.storage.from('mcp-bundles').upload(`${t.id}/fin/1.zip`, new Uint8Array([80, 75, 5, 6]), { contentType: 'application/zip' });
    if (error) throw error;
    const { ops } = fakeSprites();
    ops.provisionError = new Error('Sprites API 500');
    const v = await syncVersion(db, id, ops);
    expect(v.status).toBe('failed');
    expect(v.log_tail).toContain('建立代管環境失敗');
    expect(v.sprite_name).toBe(`agenthub-mcp-${id.replace(/-/g, '').slice(0, 12)}`);
  });

  it('不是 deploying 的版本原樣回傳', async () => {
    const creator = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    const id = await insertVersion(t.id, 1, 'ready');
    const { ops, calls } = fakeSprites();
    expect((await syncVersion(db, id, ops)).status).toBe('ready');
    expect(calls).toEqual([]);
  });
});

describe('代管版本：發布、下架、金鑰', () => {
  it('等上傳的版本可以下架；過期的等上傳與逾時的部署不再擋住新版本', async () => {
    const creator = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    const { ops, calls } = fakeSprites();
    const { version } = await createVersion(db, creator.id, t.id, 'fin');
    expect((await retireVersion(db, creator.id, version.id, ops)).status).toBe('retired');
    expect(calls).toEqual([]);

    const stalePending = await insertVersion(t.id, 2, 'pending', { created_at: new Date(Date.now() - 3 * 3600_000).toISOString() });
    const { version: v3 } = await createVersion(db, creator.id, t.id, 'fin');
    expect(v3.version).toBe(3);
    expect(await readVersion(stalePending)).toMatchObject({ status: 'failed', log_tail: '等待上傳逾時' });

    await db.from('hosted_mcp_versions').update({
      status: 'deploying', deploy_started_at: new Date(Date.now() - HOSTED_LIMITS.deployMs - 1000).toISOString(),
    }).eq('id', v3.id);
    expect((await createVersion(db, creator.id, t.id, 'fin')).version.version).toBe(4);
    expect((await readVersion(v3.id)).status).toBe('failed');
  });

  it('已上架範本：修改時新增的代管 MCP 要有已發布版本；唯一的已發布版本不能下架', async () => {
    const creator = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    const v1 = await insertVersion(t.id, 1, 'published');
    await publishTemplate(db, creator.id, t.id);
    const servers = [
      { name: 'fin', transport: 'remote' as const, hosted: true, required_secrets: [] },
      { name: 'more', transport: 'remote' as const, hosted: true, required_secrets: [] },
    ];
    await expectStatus(updateTemplate(db, creator.id, t.id, { mcp_servers: servers }), 400, 'MCP「more」還沒有已發布的版本');

    const { ops } = fakeSprites();
    await expectStatus(retireVersion(db, creator.id, v1, ops), 409, '這是已上架範本唯一的已發布版本，請先發布新版本');
    await insertVersion(t.id, 2, 'published');
    expect((await retireVersion(db, creator.id, v1, ops)).status).toBe('retired');
  });

  it('只有 ready 能發布', async () => {
    const creator = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    const ready = await insertVersion(t.id, 1, 'ready');
    const failed = await insertVersion(t.id, 2, 'failed');
    await expectStatus(publishVersion(db, (await seedUser(db)).id, ready), 404);
    const v = await publishVersion(db, creator.id, ready);
    expect(v.status).toBe('published');
    expect(v.published_at).not.toBeNull();
    await expectStatus(publishVersion(db, creator.id, failed), 409);
  });

  it('還有專案在用不能下架；沒人用就刪 Sprite 並標 retired', async () => {
    const creator = await seedUser(db);
    const renter = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    const id = await insertVersion(t.id, 1, 'published', { sprite_name: 'agenthub-mcp-r', sprite_url: 'https://r.sprites.app' });
    await publishTemplate(db, creator.id, t.id);
    const p = await createProject(db, renter.id, 'p');
    await hireAgent(db, renter.id, p.id, t.id, {});
    // 租用鎖定版本 1 之後才發布版本 2：版本 1 不是唯一的已發布版本，擋下它的是「還有專案在用」
    await insertVersion(t.id, 2, 'published');
    const { ops, calls } = fakeSprites();
    try {
      await expectStatus(retireVersion(db, creator.id, id, ops), 409, '還有專案在使用這個版本');
      expect(calls).toEqual([]);
    } finally {
      // 版本被引用時不能刪；先刪租用專案，測試結束清理帳號時才不會被擋
      await deleteOwnProject(db, renter.id, p.id);
    }
    expect((await retireVersion(db, creator.id, id, ops)).status).toBe('retired');
    expect(calls).toEqual([{ fn: 'destroy', args: ['agenthub-mcp-r'] }]);
    expect((await readVersion(id)).status).toBe('retired');
  });

  it('金鑰：名稱檢查、保留名稱、寫入後套用到執行中的版本', async () => {
    vi.stubEnv('PLATFORM_URL', 'https://platform.test');
    const creator = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    await insertVersion(t.id, 1, 'published', { sprite_name: 'agenthub-mcp-p', sprite_url: 'https://p.sprites.app' });
    await insertVersion(t.id, 2, 'failed', { sprite_name: 'agenthub-mcp-f', sprite_url: 'https://f.sprites.app' });
    // 部署中、Sprite 已建好：env 也要改寫，程式啟動時才拿得到新金鑰
    await insertVersion(t.id, 3, 'deploying', { sprite_name: 'agenthub-mcp-d', sprite_url: 'https://d.sprites.app', deploy_started_at: new Date().toISOString() });
    const { ops, calls } = fakeSprites();
    await expectStatus(setHostedSecrets(db, creator.id, t.id, 'fin', { api_key: 'x' }, ops), 400);
    await expectStatus(setHostedSecrets(db, creator.id, t.id, 'fin', { PORT: '1' }, ops), 400);
    await expectStatus(setHostedSecrets(db, creator.id, t.id, 'fin', { AGENTHUB_MCP_URL: 'x' }, ops), 400);
    await expectStatus(setHostedSecrets(db, creator.id, t.id, 'fin', { AGENTHUB_ANYTHING: 'x' }, ops), 400);
    expect(calls).toEqual([]);

    await setHostedSecrets(db, creator.id, t.id, 'fin', { API_KEY: 'v1', OTHER: 'o' }, ops);
    await setHostedSecrets(db, creator.id, t.id, 'fin', { API_KEY: 'v2' }, ops);
    const { data } = await db.rpc('get_hosted_mcp_secrets', { p_template_id: t.id, p_mcp_name: 'fin' });
    expect(data).toEqual([{ key: 'API_KEY', value: 'v2' }, { key: 'OTHER', value: 'o' }]);
    expect(calls.map((c) => c.args[0]).sort()).toEqual(['agenthub-mcp-d', 'agenthub-mcp-d', 'agenthub-mcp-p', 'agenthub-mcp-p']);
    expect(calls.filter((c) => c.args[0] === 'agenthub-mcp-p').at(-1)!.args[1]).toEqual({
      API_KEY: 'v2', OTHER: 'o', PORT: '8080',
      AGENTHUB_MCP_URL: 'https://p.sprites.app/mcp', AGENTHUB_PLATFORM_URL: 'https://platform.test',
    });
    vi.unstubAllEnvs();
  });
});
