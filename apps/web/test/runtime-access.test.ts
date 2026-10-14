import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { GET as listProjectsRoute } from '@/app/api/projects/route';
import { currentUser } from '@/lib/auth';
import { runtimeAccessToken } from '@/lib/runtime-session';
import { createProject } from '@/lib/services/projects';
import { seedUser, testDb } from './helpers';

// 用真的通行證打正式資料庫，確認 RLS 與欄位權限照權限表運作
const db = testDb();
const asToken = (token: string) => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
});

async function seedProject(prompt: string) {
  const owner = await seedUser(db);
  const p = await createProject(db, owner.id, 'p');
  const zip = `test/${randomUUID()}.zip`;
  await db.storage.from('skills').upload(zip, Buffer.from('zip'), { contentType: 'application/zip' });
  await db.storage.from('project-files').upload(`${p.id}/a.txt`, Buffer.from('a'), { contentType: 'text/plain' });
  const { data: inst } = await db.from('agent_instances')
    .insert({ project_id: p.id, role: 'consultant', name: 'x', system_prompt: prompt, skills_zip_path: zip })
    .select('id').single();
  const { data: thread } = await db.from('threads').insert({ project_id: p.id }).select('id').single();
  return { owner, project: p, zip, instanceId: inst!.id as string, threadId: thread!.id as string };
}

describe('runtime 帳號的實際權限', () => {
  it('只讀得到自己專案；讀不到帳本、專案表、別人的金鑰與檔案', async () => {
    const a = await seedProject('PROMPT A');
    const b = await seedProject('PROMPT B');
    const ra = asToken(await runtimeAccessToken(db, a.project.id));

    const { data: insts } = await ra.from('agent_instances').select('id, system_prompt');
    expect(insts).toEqual([{ id: a.instanceId, system_prompt: 'PROMPT A' }]);

    const otherRun = await ra.from('runs').insert({ thread_id: b.threadId });
    expect(otherRun.error?.code).toBe('42501');
    const ownRun = await ra.from('runs').insert({ thread_id: a.threadId }).select('id').single();
    expect(ownRun.error).toBeNull();

    expect((await ra.from('usage_events').select('id')).error?.code).toBe('42501');
    expect((await ra.from('projects').select('id')).error?.code).toBe('42501');
    expect((await ra.rpc('get_project_secrets', { p_project_id: b.project.id })).error).not.toBeNull();
    expect((await ra.rpc('get_project_secrets', { p_project_id: a.project.id })).error).toBeNull();

    expect((await ra.storage.from('skills').download(a.zip)).error).toBeNull();
    expect((await ra.storage.from('skills').download(b.zip)).error).not.toBeNull();
    const { data: files } = await ra.storage.from('project-files').list(a.project.id);
    expect(files?.map((f) => f.name)).toEqual(['a.txt']);
    expect((await ra.storage.from('project-files').list(b.project.id)).data).toEqual([]);
  });

  it('專案擁有者本人的通行證讀不到 system prompt 與 skill zip', async () => {
    const a = await seedProject('PROMPT A');
    const auth = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data } = await auth.auth.signInWithPassword({ email: a.owner.email, password: a.owner.password });
    const owner = asToken(data.session!.access_token);
    const insts = await owner.from('agent_instances').select('system_prompt');
    expect(insts.data ?? []).toEqual([]);
    expect((await owner.storage.from('skills').download(a.zip)).error).not.toBeNull();
  });

  it('runtime 帳號不能當網站使用者', async () => {
    const a = await seedProject('PROMPT A');
    const token = await runtimeAccessToken(db, a.project.id);
    const req = new Request('https://p.test/api/projects', { headers: { authorization: `Bearer ${token}` } });
    expect(await currentUser(req)).toBeNull();
    expect((await listProjectsRoute(req, {})).status).toBe(401);
  });
});
