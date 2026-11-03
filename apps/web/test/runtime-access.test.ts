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

describe('雲端資料夾的 runtime 權限', () => {
  type Client = ReturnType<typeof asToken>;

  async function upload(ra: Client, projectId: string) {
    const id = randomUUID();
    const { error } = await ra.storage.from('project-files').upload(`${projectId}/files/${id}`, Buffer.from('週報'), { contentType: 'text/plain' });
    expect(error).toBeNull();
    return id;
  }

  const deliver = (ra: Client, fileId: string, instanceId: string, subfolder = '2026-W43') =>
    ra.rpc('deliver_project_file', { p_file_id: fileId, p_instance_id: instanceId, p_subfolder: subfolder, p_name: '週報.docx', p_run_id: null });

  it('runtime 只能上傳到自己專案的 files/ 底下', async () => {
    const a = await seedProject('PROMPT A');
    const b = await seedProject('PROMPT B');
    const files = asToken(await runtimeAccessToken(db, a.project.id)).storage.from('project-files');

    const path = `${a.project.id}/files/${randomUUID()}`;
    expect((await files.upload(path, Buffer.from('1'))).error).toBeNull();
    expect((await files.upload(`${b.project.id}/files/${randomUUID()}`, Buffer.from('1'))).error).not.toBeNull();
    expect((await files.upload(`${a.project.id}/x.txt`, Buffer.from('1'))).error).not.toBeNull();
    expect((await files.upload(path, Buffer.from('2'), { upsert: true })).error).not.toBeNull();
    expect(await (await files.download(path)).data?.text()).toBe('1');
  });

  it('交付後資料表看得到、資料夾是顧問名稱', async () => {
    const a = await seedProject('PROMPT A');
    const ra = asToken(await runtimeAccessToken(db, a.project.id));
    const id = await upload(ra, a.project.id);

    const { data, error } = await deliver(ra, id, a.instanceId);
    expect(error).toBeNull();
    expect(data[0]).toEqual({ id, name: '週報.docx', folder: 'x/2026-W43', size: Buffer.byteLength('週報') });

    const { data: folders } = await ra.from('project_folders').select('name');
    expect(folders?.map((f) => f.name)).toEqual(expect.arrayContaining(['x', '2026-W43']));
    const { data: rows } = await ra.from('project_files').select('id, name, source');
    expect(rows).toEqual([{ id, name: '週報.docx', source: 'agent' }]);
  });

  it('同時交付同名檔案都成功且加序號', async () => {
    const a = await seedProject('PROMPT A');
    const ra = asToken(await runtimeAccessToken(db, a.project.id));
    const ids = [await upload(ra, a.project.id), await upload(ra, a.project.id)];

    const results = await Promise.all(ids.map((id) => deliver(ra, id, a.instanceId)));
    for (const r of results) expect(r.error).toBeNull();
    expect(results.map((r) => r.data[0].name).sort()).toEqual(['週報.docx', '週報 (2).docx'].sort());
  });

  it('顧問名稱不合法時淨化成安全的資料夾名', async () => {
    const a = await seedProject('PROMPT A');
    const ra = asToken(await runtimeAccessToken(db, a.project.id));

    await db.from('agent_instances').update({ name: '../a/b' }).eq('id', a.instanceId);
    const first = await deliver(ra, await upload(ra, a.project.id), a.instanceId, '');
    expect(first.error).toBeNull();
    expect(first.data[0].folder).toBe('.._a_b');

    await db.from('agent_instances').update({ name: '..' }).eq('id', a.instanceId);
    const second = await deliver(ra, await upload(ra, a.project.id), a.instanceId, '');
    expect(second.error).toBeNull();
    expect(second.data[0].folder).toBe('顧問');

    const { data: roots } = await ra.from('project_folders').select('name').is('parent_id', null);
    expect(roots?.map((f) => f.name).sort()).toEqual(['.._a_b', '顧問'].sort());
  });

  it('不能替別的專案的顧問交付、不能直接寫資料表', async () => {
    const a = await seedProject('PROMPT A');
    const b = await seedProject('PROMPT B');
    const ra = asToken(await runtimeAccessToken(db, a.project.id));
    const id = await upload(ra, a.project.id);

    expect((await deliver(ra, id, b.instanceId)).error).not.toBeNull();
    const insert = await ra.from('project_files').insert({
      id, project_id: a.project.id, folder_id: randomUUID(), name: '週報.docx', size: 1, content_type: 'text/plain', source: 'agent',
    });
    expect(insert.error?.code).toBe('42501');
  });

  it('子資料夾名稱不合法就拒絕', async () => {
    const a = await seedProject('PROMPT A');
    const ra = asToken(await runtimeAccessToken(db, a.project.id));
    const id = await upload(ra, a.project.id);

    expect((await deliver(ra, id, a.instanceId, '../x')).error).not.toBeNull();
  });

  it('storage 物件不存在就拒絕', async () => {
    const a = await seedProject('PROMPT A');
    const ra = asToken(await runtimeAccessToken(db, a.project.id));

    const { error } = await deliver(ra, randomUUID(), a.instanceId);
    expect(error?.message).toContain('storage object missing');
  });

  it('不能把不是自己上傳的物件登記成交付', async () => {
    const a = await seedProject('PROMPT A');
    const ra = asToken(await runtimeAccessToken(db, a.project.id));
    const id = randomUUID();
    expect((await db.storage.from('project-files').upload(`${a.project.id}/files/${id}`, Buffer.from('使用者的檔案'))).error).toBeNull();

    const { error } = await deliver(ra, id, a.instanceId);
    expect(error?.message).toContain('storage object missing');
    expect((await db.from('project_files').select('id').eq('id', id)).data).toEqual([]);
  });
});
