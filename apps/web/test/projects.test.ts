import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/http';
import {
  createProject, deleteOwnProject, getOwnProject, getProjectDetail, hireAgent, listProjects, setSpriteState,
} from '@/lib/services/projects';
import { completeUpload, createUploadUrl } from '@/lib/services/files';
import { createTemplate, publishTemplate } from '@/lib/services/templates';
import { seedUser, testDb } from './helpers';

vi.mock('@/lib/sprites', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sprites')>()),
  destroyProjectSprite: async () => {},
}));

const { DELETE: deleteProjectRoute } = await import('@/app/api/projects/[id]/route');

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

  it('組織顧問只有成員能租，租到的副本帶 org_id', async () => {
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const outsider = await seedUser(db);
    // 組織由 global setup 隨建立者（測試帳號）清掉
    const { data: org, error } = await db.from('organizations').insert({ name: '實驗室', created_by: admin.id }).select('id').single();
    if (error) throw error;
    const { error: memberError } = await db.from('org_members').insert([
      { org_id: org.id, user_id: admin.id, role: 'admin', email: admin.email },
      { org_id: org.id, user_id: member.id, role: 'member', email: member.email },
    ]);
    if (memberError) throw memberError;
    const templateId = await publishedTemplate(admin.id);
    const { error: orgError } = await db.from('agent_templates').update({ org_id: org.id }).eq('id', templateId);
    if (orgError) throw orgError;

    const outsiderProject = await createProject(db, outsider.id, 'p');
    await expectStatus(hireAgent(db, outsider.id, outsiderProject.id, templateId, {}), 403, '你不是這個組織的成員');
    expect((await getProjectDetail(db, outsider.id, outsiderProject.id)).agents).toEqual([]);

    const memberProject = await createProject(db, member.id, 'p');
    const instanceId = await hireAgent(db, member.id, memberProject.id, templateId, {});
    const { data: inst } = await db.from('agent_instances').select('org_id').eq('id', instanceId).single();
    expect(inst?.org_id).toBe(org.id);
  });

  it('專案畫面標出無法使用的顧問與原因', async () => {
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const { data: org, error } = await db.from('organizations').insert({ name: '實驗室', created_by: admin.id }).select('id').single();
    if (error) throw error;
    const { error: memberError } = await db.from('org_members').insert([
      { org_id: org.id, user_id: admin.id, role: 'admin', email: admin.email },
      { org_id: org.id, user_id: member.id, role: 'member', email: member.email },
    ]);
    if (memberError) throw memberError;
    const orgTemplate = await publishedTemplate(admin.id);
    await db.from('agent_templates').update({ org_id: org.id }).eq('id', orgTemplate);
    const publicTemplate = await publishedTemplate(admin.id, { name: '公開顧問' });

    const p = await createProject(db, member.id, 'p');
    await hireAgent(db, member.id, p.id, orgTemplate, {});
    await hireAgent(db, member.id, p.id, publicTemplate, {});
    const unavailable = async () => {
      const agents = (await getProjectDetail(db, member.id, p.id)).agents;
      return {
        org: agents.find((a) => a.template_id === orgTemplate)!.unavailable,
        pub: agents.find((a) => a.template_id === publicTemplate)!.unavailable,
      };
    };
    expect(await unavailable()).toEqual({ org: null, pub: null });

    await db.from('agent_templates').update({ status: 'draft' }).eq('id', orgTemplate);
    expect(await unavailable()).toEqual({ org: '這位顧問已從「實驗室」下架', pub: null });

    await db.from('agent_templates').update({ status: 'published' }).eq('id', orgTemplate);
    await db.from('org_members').delete().eq('org_id', org.id).eq('user_id', member.id);
    expect(await unavailable()).toEqual({ org: '你已不是「實驗室」的成員', pub: null });
  });

  it('刪除專案時刪掉 storage 裡的檔案', async () => {
    const owner = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    const bucket = db.storage.from('project-files');
    const { fileId, signedUrl } = await createUploadUrl(db, owner.id, p.id);
    await fetch(signedUrl, { method: 'PUT', body: new Blob(['new']), headers: { 'content-type': 'text/plain' } });
    await completeUpload(db, owner.id, p.id, { fileId, folderId: null, name: 'new.txt' });
    const old = await bucket.upload(`${p.id}/old.txt`, new Blob(['old']), { contentType: 'text/plain' });
    expect(old.error).toBeNull();
    expect((await bucket.list(`${p.id}/files`)).data).toHaveLength(1);

    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { data: session, error } = await client.auth.signInWithPassword(owner);
    if (error) throw error;
    const res = await deleteProjectRoute(
      new Request('https://p.test/api', { method: 'DELETE', headers: { authorization: `Bearer ${session.session!.access_token}` } }),
      { params: Promise.resolve({ id: p.id }) },
    );
    expect(res.status).toBe(200);

    expect((await bucket.list(`${p.id}/files`)).data).toEqual([]);
    expect((await bucket.list(p.id)).data).toEqual([]);
  });
});
