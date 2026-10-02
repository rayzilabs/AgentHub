import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import {
  createProject, deleteOwnProject, getOwnProject, getProjectDetail, hireAgent, listProjects, setSpriteState,
} from '@/lib/services/projects';
import { createTemplate, publishTemplate } from '@/lib/services/templates';
import { seedUser, testDb } from './helpers';

const db = testDb();

async function expectStatus(p: Promise<unknown>, status: number, message?: string) {
  const e = await p.then(() => { throw new Error('應該失敗'); }, (err) => err);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
  if (message) expect((e as HttpError).message).toBe(message);
}

async function publishedTemplate(creatorId: string, fields: Record<string, unknown> = {}) {
  const t = await createTemplate(db, creatorId, {
    name: '財務顧問', description: '財報分析', category: '財務', system_prompt: '你是會計師', mcp_servers: [], ...fields,
  });
  await publishTemplate(db, creatorId, t.id);
  return t.id;
}

describe('projects service', () => {
  it('建立、列出、只有擁有者看得到', async () => {
    const owner = await seedUser(db);
    const other = await seedUser(db);
    const p = await createProject(db, owner.id, '新產品上市');
    expect(p.sprite_status).toBe('provisioning');
    expect((await listProjects(db, owner.id)).map((x) => x.id)).toEqual([p.id]);
    expect(await listProjects(db, other.id)).toEqual([]);
    await expectStatus(getOwnProject(db, other.id, p.id), 404, '找不到這個專案');
    await expectStatus(getProjectDetail(db, other.id, p.id), 404);
    await expectStatus(deleteOwnProject(db, other.id, p.id), 404);
  });

  it('setSpriteState 更新狀態；刪除專案回傳被刪的資料', async () => {
    const owner = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    await setSpriteState(db, p.id, { sprite_status: 'ready', sprite_url: 'https://s.example' });
    expect((await getOwnProject(db, owner.id, p.id)).sprite_url).toBe('https://s.example');
    expect((await deleteOwnProject(db, owner.id, p.id)).id).toBe(p.id);
    await expectStatus(getOwnProject(db, owner.id, p.id), 404);
  });

  it('啟用 agent：第 2 位顧問時出現主管；detail 帶出 skill 與 MCP 名稱，不帶金鑰', async () => {
    const creator = await seedUser(db);
    const owner = await seedUser(db);
    const withMcp = await publishedTemplate(creator.id, {
      name: '法務顧問',
      mcp_servers: [{ name: 'law', transport: 'http', url: 'https://law.example', required_secrets: [{ key: 'LAW_KEY' }] }],
    });
    const plain = await publishedTemplate(creator.id);
    const p = await createProject(db, owner.id, 'p');

    await hireAgent(db, owner.id, p.id, withMcp, { law: { LAW_KEY: 'k' } });
    await hireAgent(db, owner.id, p.id, plain, {});
    const detail = await getProjectDetail(db, owner.id, p.id);
    expect(detail.agents.map((a) => [a.name, a.role])).toEqual([['法務顧問', 'consultant'], ['財務顧問', 'consultant'], ['主管', 'manager']]);
    expect(detail.agents[0].mcp_names).toEqual(['law']);
    expect(JSON.stringify(detail)).not.toContain('"k"');
  });

  it('啟用 agent 的錯誤：缺金鑰 400、未上架 404、別人的專案 404', async () => {
    const creator = await seedUser(db);
    const owner = await seedUser(db);
    const other = await seedUser(db);
    const withMcp = await publishedTemplate(creator.id, {
      mcp_servers: [{ name: 'law', transport: 'http', url: 'https://law.example', required_secrets: [{ key: 'LAW_KEY' }] }],
    });
    const draft = await createTemplate(db, creator.id, { name: 'd', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    const p = await createProject(db, owner.id, 'p');

    await expectStatus(hireAgent(db, owner.id, p.id, withMcp, {}), 400, '請填寫金鑰：law.LAW_KEY');
    await expectStatus(hireAgent(db, owner.id, p.id, draft.id, {}), 404, '這個 agent 尚未上架');
    await expectStatus(hireAgent(db, other.id, p.id, withMcp, { law: { LAW_KEY: 'k' } }), 404, '找不到這個專案');
    expect((await getProjectDetail(db, owner.id, p.id)).agents).toEqual([]);
  });
});
