import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostName, Machine, RuntimeHost } from '@/lib/hosts/types';
import { spriteName } from '@/lib/project-runtime';
import { hostedSpriteName, type HostedVersion } from '@/lib/services/hosted-mcp';
import { moveHostedVersion, moveProject } from '@/lib/services/move-host';
import { createProject } from '@/lib/services/projects';
import { createTemplate } from '@/lib/services/templates';
import { createThread } from '@/lib/services/threads';
import type { Db } from '@/lib/supabase/admin';
import { moveEach, type MoveOutcome, parseArgs } from '../scripts/move-host';
import { fakeHostedOps, fakeRuntimeHost, seedUser, stubHealth, testDb, testSigningKey } from './helpers';

const db = testDb();
const PROJECT_FIELDS = 'host, sprite_name, sprite_url, host_token, sprite_status, sprite_error';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 記錄每次 from(table) 與 update(patch)，其餘照常送到真的資料庫 */
function recordingDb(onFrom: (table: string) => void, onUpdate: (table: string, patch: unknown) => void = () => {}): Db {
  const bind = (t: object, k: string | symbol) => {
    const v = Reflect.get(t, k);
    return typeof v === 'function' ? v.bind(t) : v;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key !== 'from') return bind(target, key);
      return (table: string) => {
        onFrom(table);
        const q = target.from(table);
        return new Proxy(q, {
          get(t, k) {
            if (k !== 'update') return bind(t, k);
            return (patch: unknown, ...rest: unknown[]) => {
              onUpdate(table, patch);
              return (t.update as (...a: unknown[]) => unknown)(patch, ...rest);
            };
          },
        });
      };
    },
  }) as Db;
}

describe('moveProject', () => {
  async function projectOn(host: HostName, row: Record<string, unknown>) {
    const owner = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    await db.from('projects').update({ host, sprite_status: 'ready', sprite_error: null, ...row }).eq('id', p.id).throwOnError();
    return { id: p.id, owner };
  }
  const projectRow = async (id: string) => (await db.from('projects').select(PROJECT_FIELDS).eq('id', id).single().throwOnError()).data!;
  const spriteOld = (id: string) => ({ sprite_name: spriteName(id), sprite_url: 'https://old.sprites.app', host_token: null });

  function twoHosts(e2bMachine?: Machine) {
    const sprite = fakeRuntimeHost('sprite');
    const e2b = fakeRuntimeHost('e2b', e2bMachine ?? { host: 'e2b', name: 'sbx-moved', url: 'https://8080-sbx-moved.e2b.app', token: 'moved-tok' });
    const hosts = (n: HostName): RuntimeHost => (n === 'sprite' ? sprite : e2b);
    return { sprite, e2b, hosts };
  }

  it('先把專案標成 provisioning 再檢查 running run；有 running 就改回 ready 並跳過', async () => {
    const { id, owner } = await projectOn('sprite', {});
    await db.from('projects').update(spriteOld(id)).eq('id', id).throwOnError();
    const t = await createThread(db, owner.id, id);
    await db.from('runs').insert({ thread_id: t.id }).throwOnError();
    const before = await projectRow(id);
    const statusWhenChecked: PromiseLike<{ data: { sprite_status: string } | null }>[] = [];
    const spyDb = recordingDb((table) => {
      // 查詢建構器要呼叫 then 才送出：在查 runs 的當下就讀專案狀態
      if (table === 'runs') statusWhenChecked.push(db.from('projects').select('sprite_status').eq('id', id).single().then((r) => r));
    });
    const { sprite, e2b, hosts } = twoHosts();

    expect(await moveProject(spyDb, id, 'e2b', { hosts })).toBe('skipped-running');

    expect(statusWhenChecked).toHaveLength(1);
    expect((await statusWhenChecked[0]).data!.sprite_status).toBe('provisioning');
    expect(await projectRow(id)).toEqual(before);
    expect(before.sprite_status).toBe('ready');
    expect(e2b.create).not.toHaveBeenCalled();
    expect(sprite.destroy).not.toHaveBeenCalled();
    expect(e2b.destroy).not.toHaveBeenCalled();
  });

  it('超過 20 分鐘的 running run 視為已中斷，不擋搬遷', async () => {
    const { id, owner } = await projectOn('sprite', {});
    await db.from('projects').update(spriteOld(id)).eq('id', id).throwOnError();
    const t = await createThread(db, owner.id, id);
    await db.from('runs').insert({ thread_id: t.id, started_at: new Date(Date.now() - 21 * 60_000).toISOString() }).throwOnError();
    const { hosts } = twoHosts();
    stubHealth(id);

    expect(await moveProject(db, id, 'e2b', { hosts })).toBe('moved');
  });

  it('新機器健康檢查通過才一次更新 host、sprite_name、sprite_url、host_token 並刪舊機器', async () => {
    const { id } = await projectOn('sprite', {});
    await db.from('projects').update(spriteOld(id)).eq('id', id).throwOnError();
    const { sprite, e2b, hosts } = twoHosts();
    const health = vi.fn();
    const realHealth = stubHealth(id);
    realHealth.mockImplementation(async () => {
      // 健康檢查時資料列仍指向舊機器
      health((await projectRow(id)).host);
      return Response.json({ project_id: id });
    });
    const updates: unknown[] = [];
    const spyDb = recordingDb(() => {}, (table, patch) => { if (table === 'projects') updates.push(patch); });
    const hostAtSleep: string[] = [];
    e2b.extend.mockImplementation(async () => { hostAtSleep.push((await projectRow(id)).host); return 'running'; });

    expect(await moveProject(spyDb, id, 'e2b', { hosts })).toBe('moved');

    expect(e2b.create).toHaveBeenCalledExactlyOnceWith(spriteName(id), 'project');
    // 健康檢查通過後讓新沙盒 15 秒後就暫停（逐台搬時才不會同時醒著超過 Hobby 的 10 台）；換列之前做，沒有對話會打到正要睡的機器
    expect(e2b.extend.mock.calls).toEqual([[{ host: 'e2b', name: 'sbx-moved', url: 'https://8080-sbx-moved.e2b.app', token: 'moved-tok' }, 15_000]]);
    expect(e2b.extend.mock.invocationCallOrder[0]).toBeGreaterThan(realHealth.mock.invocationCallOrder[0]);
    expect(hostAtSleep).toEqual(['sprite']);
    expect(health).toHaveBeenCalledWith('sprite');
    expect(realHealth).toHaveBeenCalledWith('https://8080-sbx-moved.e2b.app/health', expect.objectContaining({ headers: { 'e2b-traffic-access-token': 'moved-tok' } }));
    expect(updates).toEqual([
      { sprite_status: 'provisioning', sprite_error: null },
      { host: 'e2b', sprite_name: 'sbx-moved', sprite_url: 'https://8080-sbx-moved.e2b.app', host_token: 'moved-tok', sprite_status: 'ready', sprite_error: null },
    ]);
    expect(await projectRow(id)).toEqual({
      host: 'e2b', sprite_name: 'sbx-moved', sprite_url: 'https://8080-sbx-moved.e2b.app', host_token: 'moved-tok', sprite_status: 'ready', sprite_error: null,
    });
    // 舊機器（Sprite）刪掉；新機器（E2B）不動
    expect(sprite.destroy.mock.calls).toEqual([[spriteName(id), 'agenthub-']]);
    expect(e2b.destroy).not.toHaveBeenCalled();
  });

  it('刪舊機器失敗（Fly 403）只警告，仍算 moved', async () => {
    const { id } = await projectOn('sprite', {});
    await db.from('projects').update(spriteOld(id)).eq('id', id).throwOnError();
    const { sprite, hosts } = twoHosts();
    sprite.destroy.mockRejectedValue(new Error('403 Forbidden'));
    stubHealth(id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await moveProject(db, id, 'e2b', { hosts })).toBe('moved');

    expect((await projectRow(id)).host).toBe('e2b');
    const message = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(message).toContain(spriteName(id));
    expect(message).toContain('sprite');
    expect(message).toContain('403 Forbidden');
  });

  it('新機器失敗：刪新機器、保留舊機器與原資料列、狀態改回 ready', async () => {
    const { id } = await projectOn('sprite', {});
    await db.from('projects').update(spriteOld(id)).eq('id', id).throwOnError();
    const before = await projectRow(id);
    const { sprite, e2b, hosts } = twoHosts();
    e2b.exec.mockRejectedValue(new Error('沙盒連不上'));

    await expect(moveProject(db, id, 'e2b', { hosts })).rejects.toThrow('沙盒連不上');

    expect(await projectRow(id)).toEqual(before);
    // E2B 依 claim 刪掉同專案的全部新沙盒；舊的 Sprite 不碰
    expect(e2b.destroy.mock.calls).toEqual([[spriteName(id), 'agenthub-']]);
    expect(sprite.destroy).not.toHaveBeenCalled();
    // 新沙盒反正要刪，不用縮短存活時間
    expect(e2b.extend).not.toHaveBeenCalled();
  });

  it('縮短新沙盒的存活時間失敗只警告，仍算 moved', async () => {
    const { id } = await projectOn('sprite', {});
    await db.from('projects').update(spriteOld(id)).eq('id', id).throwOnError();
    const { e2b, hosts } = twoHosts();
    e2b.extend.mockRejectedValue(new Error('setTimeout 503'));
    stubHealth(id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await moveProject(db, id, 'e2b', { hosts })).toBe('moved');

    expect((await projectRow(id)).host).toBe('e2b');
    const message = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(message).toContain('sbx-moved');
    expect(message).toContain('setTimeout 503');
  });

  it('專案正在佈建中：不搬、不改資料列', async () => {
    const { id } = await projectOn('sprite', { sprite_status: 'provisioning' });
    const before = await projectRow(id);
    const { e2b, hosts } = twoHosts();

    await expect(moveProject(db, id, 'e2b', { hosts })).rejects.toThrow('佈建中');

    expect(await projectRow(id)).toEqual(before);
    expect(e2b.create).not.toHaveBeenCalled();
  });

  const here = { sprite_name: 'sbx-here', sprite_url: 'https://here.e2b.app', host_token: 'tok' };
  const hereMachine: Machine = { host: 'e2b', name: 'sbx-here', url: 'https://here.e2b.app', token: 'tok' };

  it('已在目標 host 且機器還在（running／paused）：already-there，不動任何東西', async () => {
    for (const live of ['running', 'paused'] as const) {
      const { id } = await projectOn('e2b', here);
      const before = await projectRow(id);
      const { sprite, e2b, hosts } = twoHosts();
      e2b.status.mockResolvedValue(live);
      const tables: string[] = [];
      const updates: unknown[] = [];
      const spyDb = recordingDb((t) => tables.push(t), (_t, p) => updates.push(p));

      expect(await moveProject(spyDb, id, 'e2b', { hosts })).toBe('already-there');

      expect(updates).toEqual([]);
      expect(tables).toEqual(['projects']);
      expect(await projectRow(id)).toEqual(before);
      expect(e2b.status).toHaveBeenCalledExactlyOnceWith(hereMachine);
      for (const h of [sprite, e2b]) {
        for (const [name, fn] of Object.entries(h)) if (name !== 'status' && vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
      }
    }
  });

  it('同一家但機器不見（gone）：在同一家重新部署，一次換列，只依名稱刪舊的那台', async () => {
    const { id } = await projectOn('e2b', { ...here, sprite_status: 'error', sprite_error: 'agent 環境已不存在，請重新建立' });
    const { e2b, hosts } = twoHosts();
    e2b.status.mockResolvedValue('gone');
    stubHealth(id);

    expect(await moveProject(db, id, 'e2b', { hosts })).toBe('moved');

    expect(e2b.create).toHaveBeenCalledExactlyOnceWith(spriteName(id), 'project');
    expect(await projectRow(id)).toEqual({
      host: 'e2b', sprite_name: 'sbx-moved', sprite_url: 'https://8080-sbx-moved.e2b.app', host_token: 'moved-tok', sprite_status: 'ready', sprite_error: null,
    });
    // 不能依 claim 刪（會刪到新沙盒）
    expect(e2b.destroy.mock.calls).toEqual([['sbx-here', 'agenthub-']]);
    expect(e2b.extend.mock.calls.map((c) => [c[0].name, c[1]])).toEqual([['sbx-moved', 15_000]]);
  });

  it('同一家而且沒有機器：重新部署；Sprite 新舊同名時不刪', async () => {
    const { id } = await projectOn('sprite', { sprite_name: null, sprite_url: null, host_token: null, sprite_status: 'error' });
    const { sprite, hosts } = twoHosts();
    sprite.create.mockResolvedValue({ host: 'sprite', name: spriteName(id), url: 'https://new.sprites.app', token: null });
    stubHealth(id);

    expect(await moveProject(db, id, 'sprite', { hosts })).toBe('moved');

    expect(sprite.status).not.toHaveBeenCalled();
    expect((await projectRow(id)).sprite_name).toBe(spriteName(id));
    expect(sprite.destroy).not.toHaveBeenCalled();

    // 舊 Sprite 不見、以同名重建：也不刪
    const { id: id2 } = await projectOn('sprite', {});
    await db.from('projects').update(spriteOld(id2)).eq('id', id2).throwOnError();
    const two = twoHosts();
    two.sprite.status.mockResolvedValue('gone');
    two.sprite.create.mockResolvedValue({ host: 'sprite', name: spriteName(id2), url: 'https://new.sprites.app', token: null });
    stubHealth(id2);
    expect(await moveProject(db, id2, 'sprite', { hosts: two.hosts })).toBe('moved');
    expect(two.sprite.destroy).not.toHaveBeenCalled();
  });
});

describe('moveHostedVersion', () => {
  async function versionOn(host: HostName, status: string) {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, {
      name: '代管顧問', description: '', category: '', system_prompt: 'p',
      mcp_servers: [{ name: 'fin', transport: 'remote', hosted: true, required_secrets: [] }],
    });
    const { data, error } = await db.from('hosted_mcp_versions')
      .insert({ template_id: t.id, mcp_name: 'fin', version: 1, status, bundle_path: `${t.id}/fin/1.zip`, host, tools: [{ name: 'rate' }] })
      .select('id').single();
    if (error) throw error;
    const id = data.id as string;
    const old = host === 'sprite'
      ? { sprite_name: hostedSpriteName(id), sprite_url: 'https://old-mcp.sprites.app', host_token: null }
      : { sprite_name: 'sbx-old', sprite_url: 'https://8080-sbx-old.e2b.app', host_token: 'old-tok' };
    await db.from('hosted_mcp_versions').update(old).eq('id', id).throwOnError();
    const { error: uploadError } = await db.storage.from('mcp-bundles')
      .upload(`${t.id}/fin/1.zip`, new Uint8Array([80, 75, 5, 6]), { contentType: 'application/zip', upsert: true });
    if (uploadError) throw uploadError;
    return { id, old };
  }
  const versionRow = async (id: string) =>
    (await db.from('hosted_mcp_versions').select('*').eq('id', id).single().throwOnError()).data as HostedVersion;
  const opts = { pollMs: 0 };

  it('代管版本只搬 published、ready；listTools 成功才換列', async () => {
    vi.stubEnv('MCP_SIGNING_KEY', testSigningKey());
    for (const status of ['deploying', 'pending', 'failed', 'disabled', 'retired']) {
      const { id } = await versionOn('sprite', status);
      const before = await versionRow(id);
      const { ops, calls } = fakeHostedOps({ phase: 'installed', start: 'python server.py', log: 'ok' });
      expect(await moveHostedVersion(db, id, 'e2b', { ...opts, ops })).toBe('skipped');
      expect(calls).toEqual([]);
      expect(await versionRow(id)).toEqual(before);
    }

    for (const status of ['published', 'ready']) {
      const { id, old } = await versionOn('sprite', status);
      const { ops, calls } = fakeHostedOps({ phase: 'installing', log: 'pip install' });
      // 第一次讀還在安裝，第二次裝好
      const readState = ops.readState;
      let reads = 0;
      ops.readState = async (m) => {
        if (++reads === 2) ops.state = { phase: 'installed', start: 'python server.py', log: 'ok' };
        return readState(m);
      };
      // 第一次 listTools 失敗（程式還在啟動）；兩次都看資料列是否還指向舊機器
      const rowsAtListTools: HostedVersion[] = [];
      const listTools = ops.listTools;
      let lists = 0;
      ops.listTools = async (m, token) => {
        rowsAtListTools.push(await versionRow(id));
        if (++lists === 1) throw new Error('connection refused');
        return listTools(m, token);
      };

      expect(await moveHostedVersion(db, id, 'e2b', { ...opts, ops })).toBe('moved');

      const provision = calls.find((c) => c.fn === 'provision')!;
      expect(provision.args[1]).toMatchObject({ PORT: '8080' });
      expect(provision.args[2]).toContain('mcp-bundles');
      expect(rowsAtListTools.map((r) => [r.host, r.sprite_name])).toEqual([['sprite', old.sprite_name], ['sprite', old.sprite_name]]);
      const newMachine: Machine = { host: 'e2b', name: 'sbx-fake', url: 'https://8080-sbx-fake.e2b.app', token: 'fake-traffic-token' };
      expect(calls.filter((c) => c.fn === 'startService').map((c) => c.args)).toContainEqual([newMachine, 'python server.py']);
      expect(await versionRow(id)).toMatchObject({
        status, host: 'e2b', sprite_name: 'sbx-fake', sprite_url: 'https://8080-sbx-fake.e2b.app', host_token: 'fake-traffic-token',
      });
      // listTools 成功後才讓新沙盒 15 秒後就暫停（換列之前，沒有請求會打到正要睡的機器）；換列之後才刪舊機器
      const fns = calls.map((c) => c.fn);
      expect(calls.filter((c) => c.fn === 'extend').map((c) => c.args)).toEqual([[newMachine, 15_000]]);
      expect(fns.indexOf('extend')).toBeGreaterThan(fns.lastIndexOf('listTools'));
      expect(calls.filter((c) => c.fn === 'destroy').map((c) => c.args)).toEqual([['sprite', old.sprite_name]]);
      expect(calls.at(-1)!.fn).toBe('destroy');
    }
  });

  it('沒有任何工具、部署失敗或逾時：刪新機器、保留原資料列', async () => {
    vi.stubEnv('MCP_SIGNING_KEY', testSigningKey());
    const cases: [string, (ops: ReturnType<typeof fakeHostedOps>['ops']) => void, Record<string, number>][] = [
      ['沒有任何工具', (ops) => { ops.tools = []; }, {}],
      ['安裝失敗', (ops) => { ops.state = { phase: 'failed', error: '安裝失敗', log: 'pip error' }; }, {}],
      ['逾時', (ops) => { ops.listToolsError = new Error('connection refused'); }, { timeoutMs: 20 }],
    ];
    for (const [expected, setup, extra] of cases) {
      const { id } = await versionOn('sprite', 'published');
      const before = await versionRow(id);
      const { ops, calls } = fakeHostedOps({ phase: 'installed', start: 'python server.py', log: 'ok' });
      setup(ops);

      await expect(moveHostedVersion(db, id, 'e2b', { ...opts, ...extra, ops })).rejects.toThrow(expected);

      expect(await versionRow(id)).toEqual(before);
      // E2B 依 claim 刪掉這個版本的新沙盒；舊的 Sprite 不碰；反正要刪，不縮短存活時間
      expect(calls.filter((c) => c.fn === 'destroy').map((c) => c.args)).toEqual([['e2b', hostedSpriteName(id)]]);
      expect(calls.some((c) => c.fn === 'extend')).toBe(false);
    }
  });

  it('刪舊機器失敗只警告，仍算 moved', async () => {
    vi.stubEnv('MCP_SIGNING_KEY', testSigningKey());
    const { id, old } = await versionOn('sprite', 'published');
    const { ops } = fakeHostedOps({ phase: 'installed', start: 'python server.py', log: 'ok' });
    ops.destroy = async () => { throw new Error('403 Forbidden'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await moveHostedVersion(db, id, 'e2b', { ...opts, ops })).toBe('moved');

    expect((await versionRow(id)).host).toBe('e2b');
    const message = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(message).toContain(old.sprite_name);
    expect(message).toContain('403 Forbidden');
  });

  it('縮短新沙盒的存活時間失敗只警告，仍算 moved', async () => {
    vi.stubEnv('MCP_SIGNING_KEY', testSigningKey());
    const { id } = await versionOn('sprite', 'published');
    const { ops } = fakeHostedOps({ phase: 'installed', start: 'python server.py', log: 'ok' });
    ops.extendError = new Error('setTimeout 503');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await moveHostedVersion(db, id, 'e2b', { ...opts, ops })).toBe('moved');

    expect((await versionRow(id)).host).toBe('e2b');
    const message = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(message).toContain('sbx-fake');
    expect(message).toContain('setTimeout 503');
  });

  it('已在目標 host 且機器還在（running／paused）：already-there，不動任何東西', async () => {
    for (const live of ['running', 'paused'] as const) {
      const { id, old } = await versionOn('e2b', 'published');
      const before = await versionRow(id);
      const { ops, calls } = fakeHostedOps({ phase: 'installed', start: 'python server.py', log: 'ok' });
      ops.live = live;

      expect(await moveHostedVersion(db, id, 'e2b', { ...opts, ops })).toBe('already-there');

      expect(calls).toEqual([{ fn: 'status', args: [{ host: 'e2b', name: old.sprite_name, url: old.sprite_url, token: old.host_token }] }]);
      expect(await versionRow(id)).toEqual(before);
    }
  });

  it('同一家但機器不見（gone）：在同一家重新部署，listTools 成功才換列，只依 sandboxId 刪舊的那台', async () => {
    vi.stubEnv('MCP_SIGNING_KEY', testSigningKey());
    const { id, old } = await versionOn('e2b', 'published');
    const { ops, calls } = fakeHostedOps({ phase: 'installed', start: 'python server.py', log: 'ok' });
    ops.live = 'gone';

    expect(await moveHostedVersion(db, id, 'e2b', { ...opts, ops })).toBe('moved');

    expect(calls.map((c) => c.fn)).toEqual(['status', 'provision', 'readState', 'startService', 'listTools', 'extend', 'destroy']);
    expect(await versionRow(id)).toMatchObject({
      host: 'e2b', sprite_name: 'sbx-fake', sprite_url: 'https://8080-sbx-fake.e2b.app', host_token: 'fake-traffic-token',
    });
    // 不能依 claim 刪（會刪到新沙盒）
    expect(calls.at(-1)!.args).toEqual(['e2b', old.sprite_name]);
  });

  it('同一家 Sprite 不見：以同名重建，不刪', async () => {
    vi.stubEnv('MCP_SIGNING_KEY', testSigningKey());
    const { id } = await versionOn('sprite', 'ready');
    const { ops, calls } = fakeHostedOps({ phase: 'installed', start: 'python server.py', log: 'ok' });
    ops.live = 'gone';

    expect(await moveHostedVersion(db, id, 'sprite', { ...opts, ops })).toBe('moved');

    expect(calls.some((c) => c.fn === 'destroy')).toBe(false);
    expect(await versionRow(id)).toMatchObject({ host: 'sprite', sprite_name: hostedSpriteName(id), sprite_url: 'https://fake-mcp.sprites.app' });
  });
});

describe('move-host.ts 指令', () => {
  const id = '11111111-2222-3333-4444-555555555555';

  it('parseArgs：--to 必填且只能是 sprite／e2b，目標三選一', () => {
    expect(parseArgs(['--to', 'e2b', '--project', id])).toEqual({ to: 'e2b', target: { kind: 'project', id } });
    expect(parseArgs(['--version', id, '--to', 'sprite'])).toEqual({ to: 'sprite', target: { kind: 'version', id } });
    expect(parseArgs(['--to', 'e2b', '--all'])).toEqual({ to: 'e2b', target: { kind: 'all' } });
    for (const bad of [
      [], ['--all'], ['--to', 'fly', '--all'], ['--to', 'e2b'], ['--to', 'e2b', '--project', 'nope'],
      ['--to', 'e2b', '--all', '--project', id], ['--to', 'e2b', '--all', '--extra'],
    ]) {
      expect(() => parseArgs(bad), bad.join(' ')).toThrow('用法');
    }
  });

  it('moveEach：一次一台、每台印一行，最後列出跳過與失敗', async () => {
    const lines: string[] = [];
    let active = 0;
    let maxActive = 0;
    const step = (result: MoveOutcome | Error) => async (): Promise<MoveOutcome> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (result instanceof Error) throw result;
      return result;
    };
    const summary = await moveEach([
      { label: '專案 a', run: step('moved') },
      { label: '專案 b', run: step('skipped-running') },
      { label: '專案 c', run: step(new Error('沙盒連不上')) },
      { label: '版本 d', run: step('already-there') },
      { label: '版本 e', run: step('skipped') },
    ], (l) => lines.push(l));

    expect(maxActive).toBe(1);
    expect(summary).toEqual({ moved: ['專案 a'], alreadyThere: ['版本 d'], skipped: ['專案 b', '版本 e'], failed: ['專案 c'] });
    expect(lines.slice(0, 5)).toEqual([
      '專案 a：已搬遷',
      '專案 b：跳過（有進行中的對話）',
      '專案 c：失敗（沙盒連不上）',
      '版本 d：已在目標執行環境',
      '版本 e：跳過（狀態不需要搬）',
    ]);
    const tail = lines.slice(5).join('\n');
    expect(tail).toContain('跳過：專案 b、版本 e');
    expect(tail).toContain('失敗：專案 c');
  });
});
