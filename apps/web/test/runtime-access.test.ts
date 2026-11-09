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

  it('專案擁有者本人的一般通行證不能交付，也讀不到雲端資料夾的資料表', async () => {
    const a = await seedProject('PROMPT A');
    const ra = asToken(await runtimeAccessToken(db, a.project.id));
    expect((await deliver(ra, await upload(ra, a.project.id), a.instanceId)).error).toBeNull();

    const auth = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data } = await auth.auth.signInWithPassword({ email: a.owner.email, password: a.owner.password });
    const owner = asToken(data.session!.access_token);

    const id = randomUUID();
    expect((await db.storage.from('project-files').upload(`${a.project.id}/files/${id}`, Buffer.from('1'))).error).toBeNull();
    const delivered = await deliver(owner, id, a.instanceId);
    expect(delivered.error?.message).toBe('not allowed');
    expect(delivered.data).toBeNull();
    expect((await db.from('project_files').select('id').eq('id', id)).data).toEqual([]);

    for (const table of ['project_folders', 'project_files']) {
      // 唯一的讀取 policy 只認 runtime 通行證：查詢不報錯，只是一筆都拿不到
      const { data: rows, error } = await owner.from(table).select('id').eq('project_id', a.project.id);
      expect(error).toBeNull();
      expect(rows).toEqual([]);
    }
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

describe('組織顧問的 runtime 權限', () => {
  const ok = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) throw error;
  };

  // 專案有一位組織顧問（seedProject 的顧問補上 org_id、template_id）與一位公開顧問；組織由 global setup 隨建立者清掉
  async function seedOrgProject() {
    const base = await seedProject('PROMPT 組織');
    const admin = await seedUser(db);
    const orgName = `組織-${randomUUID().slice(0, 8)}`;
    const { data: org, error } = await db.from('organizations').insert({ name: orgName, created_by: admin.id }).select('id').single();
    if (error) throw error;
    const orgId = org.id as string;
    await ok(db.from('org_members').insert([
      { org_id: orgId, user_id: admin.id, role: 'admin', email: admin.email },
      { org_id: orgId, user_id: base.owner.id, role: 'member', email: base.owner.email },
    ]));
    const { data: tpl } = await db.from('agent_templates')
      .insert({ creator_id: admin.id, name: '組織顧問', org_id: orgId, status: 'published', skills_zip_path: base.zip })
      .select('id').single();
    const templateId = tpl!.id as string;
    await ok(db.from('agent_instances').update({ org_id: orgId, template_id: templateId }).eq('id', base.instanceId));
    const { data: pub } = await db.from('agent_instances')
      .insert({ project_id: base.project.id, role: 'consultant', name: '公開顧問', system_prompt: 'PROMPT 公開' })
      .select('id').single();
    const ra = asToken(await runtimeAccessToken(db, base.project.id));
    return {
      ...base, ra, orgName, templateId, orgInstanceId: base.instanceId, publicInstanceId: pub!.id as string,
      removeOwner: () => ok(db.from('org_members').delete().eq('org_id', orgId).eq('user_id', base.owner.id)),
      addOwner: () => ok(db.from('org_members').insert({ org_id: orgId, user_id: base.owner.id, role: 'member', email: base.owner.email })),
      setStatus: (status: string) => ok(db.from('agent_templates').update({ status }).eq('id', templateId)),
      visible: async () => ((await ra.from('agent_instances').select('id')).data ?? []).map((i) => i.id as string).sort(),
    };
  }

  it('runtime 讀不到被擋的組織顧問', async () => {
    const s = await seedOrgProject();
    // Storage 的下載有快取：先下載過，被擋之後同一個 zip 還下載得到，所以擋之前用 list 確認讀得到
    const listZip = async () =>
      ((await s.ra.storage.from('skills').list('test', { search: s.zip.slice('test/'.length) })).data ?? []).map((o) => o.name);
    expect(await listZip()).toEqual([s.zip.slice('test/'.length)]);
    expect(await s.visible()).toEqual([s.orgInstanceId, s.publicInstanceId].sort());
    expect((await s.ra.from('agent_templates').select('id')).data).toEqual([{ id: s.templateId }]);

    await s.removeOwner();
    expect(await s.visible()).toEqual([s.publicInstanceId]);
    expect(await listZip()).toEqual([]);
    expect((await s.ra.storage.from('skills').download(s.zip)).error).not.toBeNull();
    const { data: templates, error } = await s.ra.from('agent_templates').select('id');
    expect(error).toBeNull();
    expect(templates?.map((t) => t.id)).not.toContain(s.templateId);
  });

  it('重新加入與重新上架後恢復', async () => {
    const s = await seedOrgProject();
    const both = [s.orgInstanceId, s.publicInstanceId].sort();

    await s.removeOwner();
    expect(await s.visible()).toEqual([s.publicInstanceId]);
    await s.addOwner();
    expect(await s.visible()).toEqual(both);

    await s.setStatus('draft');
    expect(await s.visible()).toEqual([s.publicInstanceId]);
    await s.setStatus('published');
    expect(await s.visible()).toEqual(both);
  });

  it('Storage 下載快取只限同一張通行證', async () => {
    const s = await seedOrgProject();
    const b = await seedProject('PROMPT B');
    const rb = asToken(await runtimeAccessToken(db, b.project.id));
    const download = async (c: ReturnType<typeof asToken>) => (await c.storage.from('skills').download(s.zip)).error;

    expect(await download(s.ra)).toBeNull();
    // 別的專案：A 剛下載過也拿不到
    expect(await download(rb)).not.toBeNull();

    await s.removeOwner();
    // 同一張通行證被擋之後還可能從快取拿得到（docs/security-model.md 第 7 節）；快取多久不保證，所以不斷言
    // 同一個 runtime 帳號重新登入的新通行證：照 policy 拒絕
    const { data: row } = await db.from('project_runtime_accounts').select('user_id, password').eq('project_id', s.project.id).single();
    const { data: account } = await db.auth.admin.getUserById(row!.user_id as string);
    const auth = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: session, error } = await auth.auth.signInWithPassword({ email: account.user!.email!, password: row!.password as string });
    if (error) throw error;
    expect(session.session!.access_token).not.toBe(await runtimeAccessToken(db, s.project.id));
    expect(await download(asToken(session.session!.access_token))).not.toBeNull();
    expect(await download(rb)).not.toBeNull();
  });

  it('project_instance_problems 回傳原因', async () => {
    const s = await seedOrgProject();
    const problems = async () => {
      const { data, error } = await db.rpc('project_instance_problems', { p_project_id: s.project.id });
      expect(error).toBeNull();
      return data;
    };
    expect(await problems()).toEqual([]);

    await s.removeOwner();
    expect(await problems()).toEqual([{ instance_id: s.orgInstanceId, org_name: s.orgName, problem: 'not_member' }]);

    await s.addOwner();
    await s.setStatus('draft');
    expect(await problems()).toEqual([{ instance_id: s.orgInstanceId, org_name: s.orgName, problem: 'unpublished' }]);
  });
});
