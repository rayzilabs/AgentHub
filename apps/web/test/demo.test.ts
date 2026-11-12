import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { loadDemoAgents, publishDemoAgents, type DemoAgent } from '@/lib/demo';
import { TemplateInputSchema } from '@/lib/schemas';
import { listVersions } from '@/lib/services/hosted-mcp';
import { listMyTemplates, listPublishedTemplates } from '@/lib/services/templates';
import { parseSkillsZip } from '@/lib/skills-zip';
import { fakeSprites, seedUser, testDb } from './helpers';

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
    // 部署檢查會簽創作者通行證
    vi.stubEnv('PLATFORM_URL', 'https://platform.test');
    vi.stubEnv('MCP_SIGNING_KEY', generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const creator = await seedUser(db);
    const { agents, hosted } = await fixture();
    const { ops, calls } = fakeSprites({ phase: 'installed', start: 'node server.mjs', log: 'ok' });

    const [first] = await publishDemoAgents(db, creator.id, await loadDemoAgents(agents, hosted), ops);
    expect(first.deployed).toEqual(['law']);
    expect((await listPublishedTemplates(db)).some((t) => t.id === first.id)).toBe(true);
    expect((await listVersions(db, creator.id, first.id, 'law')).map((v) => [v.version, v.status])).toEqual([[1, 'published']]);

    const [same] = await publishDemoAgents(db, creator.id, await loadDemoAgents(agents, hosted), ops);
    expect(same.deployed).toEqual([]);
    expect(await listVersions(db, creator.id, first.id, 'law')).toHaveLength(1);

    await writeFile(path.join(hosted, 'law/server.mjs'), 'v2');
    const [changed] = await publishDemoAgents(db, creator.id, await loadDemoAgents(agents, hosted), ops);
    expect(changed.deployed).toEqual(['law']);
    expect((await listVersions(db, creator.id, first.id, 'law')).map((v) => [v.version, v.status])).toEqual([[2, 'published'], [1, 'retired']]);
    expect(calls.filter((c) => c.fn === 'destroy')).toHaveLength(1);
  });
});
