import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiHostedClient, BUSINESS_AGENTS_ROOT, loadDemoAgents, publishDemoAgents, type DemoAgent } from '@/lib/demo';
import { HttpError } from '@/lib/http';
import { TemplateInputSchema } from '@/lib/schemas';
import { listVersions } from '@/lib/services/hosted-mcp';
import { listMyTemplates, listPublishedTemplates } from '@/lib/services/templates';
import { parseSkillsZip } from '@/lib/skills-zip';
import { fakeSprites, seedUser, serviceHostedClient, testDb, testSigningKey } from './helpers';

const SKILLS: Record<string, string[]> = {
  credit: ['credit-5p', 'ratio-check'],
  compliance: ['aml-kyc', 'data-privacy'],
  finance: ['cashflow', 'valuation'],
};

describe('loadDemoAgents', () => {
  it('讀出三位顧問，內容通過格式檢查，skill zip 可以解析', async () => {
    const agents = await loadDemoAgents();
    expect(agents.map((a) => a.slug)).toEqual(['compliance', 'credit', 'finance']);
    for (const a of agents) {
      expect(TemplateInputSchema.parse(a.input)).toEqual(a.input);
      expect(a.input.description).toContain('（示範內容，正式版本將由執業專業人士提供）');
      expect(a.input.system_prompt).toContain('以下為一般性分析，不構成正式法律、財務或授信意見');
      expect(parseSkillsZip(a.skillsZip)).toHaveLength(2);
      expect(parseSkillsZip(a.skillsZip).map((k) => k.name).sort()).toEqual(SKILLS[a.slug]);
    }
  });
});

describe('非金融顧問（只上架到市集）', () => {
  const LEGAL_SKILLS = ['ad-claims-review', 'contract-review', 'legal-letter', 'legal-risk-triage', 'legal-setup', 'nda-review', 'online-terms-review', 'privacy-check'];

  it('企業法務顧問：格式正確、兩句標示都在、8 個 skill、用平台代管的 taiwan-law', async () => {
    const agents = await loadDemoAgents(BUSINESS_AGENTS_ROOT);
    const legal = agents.find((a) => a.slug === 'legal');
    expect(legal).toBeDefined();
    const a = legal!;
    expect(TemplateInputSchema.parse(a.input)).toEqual(a.input);
    expect(a.input.description).toContain('（示範內容，正式版本將由執業專業人士提供）');
    expect(a.input.system_prompt).toContain('以下為一般性分析，不構成正式法律、財務或授信意見');
    expect(a.input.mcp_servers).toEqual([{ name: 'taiwan-law', transport: 'remote', hosted: true, required_secrets: [] }]);
    expect(Object.keys(a.hosted)).toEqual(['taiwan-law']);
    expect(parseSkillsZip(a.skillsZip).map((k) => k.name).sort()).toEqual(LEGAL_SKILLS);
  });

  it('企業法務顧問：每個 skill 結尾有來源段落，資料夾有 NOTICE.md', async () => {
    const dir = path.join(BUSINESS_AGENTS_ROOT, 'legal');
    expect(await readFile(path.join(dir, 'NOTICE.md'), 'utf8')).toContain('Apache License 2.0');
    for (const name of LEGAL_SKILLS) {
      const md = await readFile(path.join(dir, 'skills', name, 'SKILL.md'), 'utf8');
      expect(md, name).toMatch(/\n## 來源\n/);
    }
  });
});

describe('publishDemoAgents', () => {
  const db = testDb();
  const agent = (description: string): DemoAgent => ({
    slug: 'legal',
    input: TemplateInputSchema.parse({ name: `上架測試-${randomUUID()}`, description, system_prompt: '你是法務顧問' }),
    skillsZip: zipSync({ 'review/SKILL.md': strToU8('---\nname: review\ndescription: 審合約\n---\n') }),
    hosted: {},
  });

  it('第一次建立並上架到市集；同名再跑一次是更新同一個範本，不會重複建立', async () => {
    const creator = await seedUser(db);
    const first = agent('第一版');
    const [created] = await publishDemoAgents(db, creator.id, [first]);
    expect(created.created).toBe(true);
    const listed = (await listPublishedTemplates(db)).find((t) => t.id === created.id);
    expect(listed?.description).toBe('第一版');

    const [updated] = await publishDemoAgents(db, creator.id, [{ ...first, input: { ...first.input, description: '第二版' } }]);
    expect(updated).toEqual({ id: created.id, name: first.input.name, created: false, deployed: [] });
    const mine = await listMyTemplates(db, creator.id);
    expect(mine.filter((t) => t.name === first.input.name)).toHaveLength(1);
    expect(mine.find((t) => t.id === created.id)).toMatchObject({ description: '第二版', status: 'published' });
    expect(mine.find((t) => t.id === created.id)?.skills.map((k) => k.name)).toEqual(['review']);
  });
});

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
}

describe('平台代管 MCP 套件', () => {
  const db = testDb();
  // 部署檢查會簽創作者通行證
  beforeEach(() => {
    vi.stubEnv('PLATFORM_URL', 'https://platform.test');
    vi.stubEnv('MCP_SIGNING_KEY', testSigningKey());
  });
  const agentJson = (name: string) => JSON.stringify({
    name, system_prompt: '你是法務顧問', mcp_servers: [{ name: 'law', transport: 'remote', hosted: true }],
  });

  async function fixture(name = `代管測試-${randomUUID()}`) {
    const base = await mkdtemp(path.join(tmpdir(), 'demo-agents-'));
    const agents = path.join(base, 'agents');
    const hosted = path.join(base, 'hosted-mcp');
    await writeFiles(agents, { 'legal/agent.json': agentJson(name), 'legal/skills/review/SKILL.md': '---\nname: review\ndescription: 審合約\n---\n' });
    await writeFiles(hosted, {
      'law/mcp.json': '{"runtime":"node","start":"node server.mjs"}', 'law/server.mjs': 'v1',
      'law/__pycache__/x.pyc': 'x', 'law/node_modules/sdk/index.js': 'x', 'law/.venv/bin/python': 'x', 'law/a.pyc': 'x', 'law/.DS_Store': 'x',
    });
    return { agents, hosted };
  }

  it('依 agent.json 的代管 MCP 名稱讀 hosted-mcp/<名稱>/，略過暫存與套件安裝目錄', async () => {
    const { agents, hosted } = await fixture();
    const [agent] = await loadDemoAgents(agents, hosted);
    expect(Object.keys(agent.hosted)).toEqual(['law']);
    expect(Object.keys(agent.hosted.law).sort()).toEqual(['mcp.json', 'server.mjs']);
  });

  it('找不到代管套件時說清楚缺哪個資料夾', async () => {
    const { agents } = await fixture();
    await expect(loadDemoAgents(agents, path.join(tmpdir(), `none-${randomUUID()}`))).rejects.toThrow(/找不到代管 MCP「law」的套件/);
  });

  it('第一次部署並發布；內容沒變不建新版本；內容變了建新版本並下架沒人用的舊版本', async () => {
    const creator = await seedUser(db);
    const { agents, hosted } = await fixture();
    const { ops, calls } = fakeSprites({ phase: 'installed', start: 'node server.mjs', log: 'ok' });

    const [first] = await publishDemoAgents(db, creator.id, await loadDemoAgents(agents, hosted), serviceHostedClient(db, creator.id, ops));
    expect(first.deployed).toEqual(['law']);
    expect((await listPublishedTemplates(db)).some((t) => t.id === first.id)).toBe(true);
    expect((await listVersions(db, creator.id, first.id, 'law')).map((v) => [v.version, v.status])).toEqual([[1, 'published']]);

    const [same] = await publishDemoAgents(db, creator.id, await loadDemoAgents(agents, hosted), serviceHostedClient(db, creator.id, ops));
    expect(same.deployed).toEqual([]);
    expect(await listVersions(db, creator.id, first.id, 'law')).toHaveLength(1);

    await writeFile(path.join(hosted, 'law/server.mjs'), 'v2');
    const [changed] = await publishDemoAgents(db, creator.id, await loadDemoAgents(agents, hosted), serviceHostedClient(db, creator.id, ops));
    expect(changed.deployed).toEqual(['law']);
    expect((await listVersions(db, creator.id, first.id, 'law')).map((v) => [v.version, v.status])).toEqual([[2, 'published'], [1, 'retired']]);
    expect(calls.filter((c) => c.fn === 'destroy')).toHaveLength(1);
  });

  it('內容沒變時，也會下架上次中斷留下的失敗版本', async () => {
    const creator = await seedUser(db);
    const { agents, hosted } = await fixture();
    const { ops } = fakeSprites({ phase: 'installed', start: 'node server.mjs', log: 'ok' });
    const [first] = await publishDemoAgents(db, creator.id, await loadDemoAgents(agents, hosted), serviceHostedClient(db, creator.id, ops));
    const { error } = await db.from('hosted_mcp_versions')
      .insert({ template_id: first.id, mcp_name: 'law', version: 2, status: 'failed', bundle_path: `${first.id}/law/2.zip`, sprite_name: 'agenthub-mcp-leftover00000' });
    if (error) throw error;

    const [again] = await publishDemoAgents(db, creator.id, await loadDemoAgents(agents, hosted), serviceHostedClient(db, creator.id, ops));
    expect(again.deployed).toEqual([]);
    expect((await listVersions(db, creator.id, first.id, 'law')).map((v) => [v.version, v.status])).toEqual([[2, 'retired'], [1, 'published']]);
  });

  it('有代管 MCP 卻沒給 HostedClient 時說明要怎麼做', async () => {
    const creator = await seedUser(db);
    const { agents, hosted } = await fixture();
    await expect(publishDemoAgents(db, creator.id, await loadDemoAgents(agents, hosted))).rejects.toThrow(/平台代管 MCP/);
  });
});

describe('apiHostedClient：呼叫正式站的代管 API', () => {
  it('帶創作者 Bearer token 打對的路徑與方法，錯誤轉成 HttpError', async () => {
    const seen: string[] = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url} ${(init?.headers as Record<string, string>).authorization}`);
      if (String(url).endsWith('/publish')) return Response.json({ error: '只有部署成功的版本可以發布' }, { status: 409 });
      return Response.json({ id: 'v1', status: 'ready' });
    };
    const api = apiHostedClient('https://platform.test/', 'tok', fakeFetch as typeof fetch);
    await api.list('t', 'law');
    await api.create('t', 'law');
    await api.deploy('t', 'law', 'v1');
    await api.get('t', 'law', 'v1');
    await api.retire('t', 'law', 'v1');
    const e = await api.publish('t', 'law', 'v1').then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 409, message: '只有部署成功的版本可以發布' });
    const base = 'https://platform.test/api/templates/t/hosted/law/versions';
    expect(seen).toEqual([
      `GET ${base} Bearer tok`, `POST ${base} Bearer tok`, `POST ${base}/v1/deploy Bearer tok`,
      `GET ${base}/v1 Bearer tok`, `DELETE ${base}/v1 Bearer tok`, `POST ${base}/v1/publish Bearer tok`,
    ]);
  });
});
