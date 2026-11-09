import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import { acceptInvitation, createOrg, invite, listMyInvitations, removeMember, updateOrg } from '@/lib/services/orgs';
import {
  createSkillsUploadUrl, createTemplate, getTemplate, listMyTemplates, listOrgTemplates, listPublishedTemplates, publishTemplate,
  reviewTemplate, unpublishTemplate, updateTemplate,
} from '@/lib/services/templates';
import { seedUser, testDb } from './helpers';

const db = testDb();

async function uploadViaSignedUrl(signedUrl: string, bytes: Uint8Array) {
  const res = await fetch(signedUrl, { method: 'PUT', body: new Blob([bytes as BlobPart]), headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
  expect(res.ok).toBe(true);
}

const goodZip = () => zipSync({ 'review/SKILL.md': strToU8('---\nname: review\ndescription: 審合約\n---\n') });

async function expectStatus(p: Promise<unknown>, status: number, message?: string) {
  const e = await p.then(() => { throw new Error('應該失敗'); }, (err) => err);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
  if (message) expect((e as HttpError).message).toBe(message);
}

describe('templates service', () => {
  it('建立草稿、只有自己看得到；上架後出現在市集', async () => {
    const creator = await seedUser(db);
    const other = await seedUser(db);
    const t = await createTemplate(db, creator.id, {
      name: '法務顧問', description: '契約審查', category: '法律', system_prompt: '你是律師', mcp_servers: [],
    });
    expect(t.status).toBe('draft');
    expect((await listMyTemplates(db, creator.id)).map((x) => x.id)).toContain(t.id);
    await expectStatus(getTemplate(db, t.id, other.id), 404, '找不到這個 agent');
    await expectStatus(getTemplate(db, t.id, null), 404);
    expect((await getTemplate(db, t.id, creator.id)).name).toBe('法務顧問');

    await publishTemplate(db, creator.id, t.id);
    const listed = (await listPublishedTemplates(db)).find((x) => x.id === t.id);
    expect(listed?.creator_name).toBe(creator.email.split('@')[0]);
    expect((await getTemplate(db, t.id, null)).status).toBe('published');
  });

  it('市集與非擁有者看不到 system prompt、skill 檔路徑與 MCP 連線設定；擁有者看得到', async () => {
    const creator = await seedUser(db);
    const other = await seedUser(db);
    const secrets = [{ key: 'API_KEY', description: '服務金鑰' }];
    const t = await createTemplate(db, creator.id, {
      name: '私密顧問', description: '', category: '', system_prompt: '機密工作方法',
      mcp_servers: [
        { name: 'web', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' }, required_secrets: secrets },
        { name: 'local', transport: 'stdio', command: 'npx', args: ['secret-server'], required_secrets: [] },
      ],
    });
    await publishTemplate(db, creator.id, t.id);
    const publicServers = [
      { name: 'web', transport: 'http', required_secrets: secrets },
      { name: 'local', transport: 'stdio', required_secrets: [] },
    ];

    const listed = (await listPublishedTemplates(db)).find((x) => x.id === t.id)!;
    for (const view of [listed, await getTemplate(db, t.id, null), await getTemplate(db, t.id, other.id)]) {
      expect(view).not.toHaveProperty('system_prompt');
      expect(view).not.toHaveProperty('skills_zip_path');
      expect(view.mcp_servers).toEqual(publicServers);
      expect(view.name).toBe('私密顧問');
    }

    const own = await getTemplate(db, t.id, creator.id);
    expect(own).toHaveProperty('system_prompt', '機密工作方法');
    expect(own.mcp_servers).toEqual([
      expect.objectContaining({ name: 'web', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }),
      expect.objectContaining({ name: 'local', command: 'npx', args: ['secret-server'] }),
    ]);
  });

  it('別人不能修改或上架', async () => {
    const creator = await seedUser(db);
    const other = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    await expectStatus(updateTemplate(db, other.id, t.id, { name: 'hack' }), 404);
    await expectStatus(publishTemplate(db, other.id, t.id), 404);
    await expectStatus(createSkillsUploadUrl(db, other.id, t.id), 404);
  });

  it('system prompt 空白不能上架', async () => {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: '  ', mcp_servers: [] });
    await expectStatus(publishTemplate(db, creator.id, t.id), 400, '請先填寫 system prompt');
  });

  it('上傳 skill zip 後處理：解析 skill、檔名換成內容雜湊、刪掉暫存檔', async () => {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    const { signedUrl, path } = await createSkillsUploadUrl(db, creator.id, t.id);
    expect(path).toBe(`${t.id}/upload.zip`);
    await uploadViaSignedUrl(signedUrl, goodZip());

    const updated = await updateTemplate(db, creator.id, t.id, { process_upload: true, name: '新名字' });
    expect(updated.name).toBe('新名字');
    expect(updated.skills).toEqual([{ name: 'review', description: '審合約', path: 'review' }]);
    expect(updated.skills_zip_path).toMatch(new RegExp(`^${t.id}/[0-9a-f]{64}\\.zip$`));
    const { data: list } = await db.storage.from('skills').list(t.id);
    expect(list!.map((o) => o.name)).not.toContain('upload.zip');
  });

  it('skill zip 有問題時 400 並列出全部問題，資料不變', async () => {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    const { signedUrl } = await createSkillsUploadUrl(db, creator.id, t.id);
    await uploadViaSignedUrl(signedUrl, zipSync({ 'a/SKILL.md': strToU8('沒有設定區') }));
    await expectStatus(
      updateTemplate(db, creator.id, t.id, { process_upload: true }),
      400,
      'a/SKILL.md：開頭缺少 --- 包住的設定區（name、description）',
    );
    expect(await getTemplate(db, t.id, creator.id)).toHaveProperty('skills_zip_path', null);
  });

  it('requirements.txt 寫了不接受的內容：400 並指出檔案與行號，資料不變', async () => {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    const { signedUrl } = await createSkillsUploadUrl(db, creator.id, t.id);
    await uploadViaSignedUrl(signedUrl, zipSync({
      'review/SKILL.md': strToU8('---\nname: review\ndescription: 審合約\n---\n'),
      'review/requirements.txt': strToU8('numpy\n-e git+https://example.com/x.git\n'),
    }));
    await expectStatus(updateTemplate(db, creator.id, t.id, { process_upload: true }), 400, 'review/requirements.txt：第 2 行：不接受 - 開頭的選項（只能寫套件名稱與版本）');
    expect(await getTemplate(db, t.id, creator.id)).toHaveProperty('skills_zip_path', null);
  });

  it('還沒上傳就要求處理：400', async () => {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    await expectStatus(updateTemplate(db, creator.id, t.id, { process_upload: true }), 400, '還沒有上傳 skill 檔案');
  });
});

/** admin 建組織；member、member2 由 admin 邀請、接受後直接加入；outsider 不在組織裡。 */
async function seedOrg() {
  const [admin, member, member2, outsider] = await Promise.all([seedUser(db), seedUser(db), seedUser(db), seedUser(db)]);
  const orgId = (await createOrg(db, admin, { name: '測試實驗室' })).id;
  for (const who of [member, member2]) {
    await invite(db, admin.id, orgId, who.email);
    const inv = (await listMyInvitations(db, who.email)).find((i) => i.org_id === orgId)!;
    await acceptInvitation(db, who, inv.id);
  }
  return { admin, member, member2, outsider, orgId };
}

const orgInput = (orgId: string) => ({
  name: '組織顧問', description: '實驗室內部', category: '金融', system_prompt: '內部方法', mcp_servers: [], org_id: orgId,
});

describe('組織範本', () => {
  it('組織範本不出現在公開市集', async () => {
    const { member, outsider, orgId } = await seedOrg();
    const t = await createTemplate(db, member.id, orgInput(orgId));
    expect(t.org_id).toBe(orgId);
    expect((await publishTemplate(db, member.id, t.id)).status).toBe('published');

    expect((await listPublishedTemplates(db)).map((x) => x.id)).not.toContain(t.id);
    const listed = (await listOrgTemplates(db, member.id, orgId)).find((x) => x.id === t.id);
    expect(listed).toMatchObject({ org_id: orgId, org_name: '測試實驗室', editable: true });
    expect(listed).not.toHaveProperty('system_prompt');
    await expectStatus(listOrgTemplates(db, outsider.id, orgId), 404, '找不到這個組織');
  });

  it('非成員用網址直接看組織範本是 404', async () => {
    const { member, outsider, orgId } = await seedOrg();
    const t = await createTemplate(db, member.id, orgInput(orgId));
    await publishTemplate(db, member.id, t.id);
    await expectStatus(getTemplate(db, t.id, outsider.id), 404, '找不到這個 agent');
    await expectStatus(getTemplate(db, t.id, null), 404, '找不到這個 agent');
  });

  it('一般成員只看得到公開欄位', async () => {
    const { admin, member, member2, orgId } = await seedOrg();
    const t = await createTemplate(db, member.id, orgInput(orgId));
    await expectStatus(getTemplate(db, t.id, member2.id), 404, '找不到這個 agent');
    await publishTemplate(db, member.id, t.id);

    const seen = await getTemplate(db, t.id, member2.id);
    expect('system_prompt' in seen).toBe(false);
    expect('skills_zip_path' in seen).toBe(false);
    expect(seen.org_name).toBe('測試實驗室');
    expect(await getTemplate(db, t.id, admin.id)).toHaveProperty('system_prompt', '內部方法');
    expect(await getTemplate(db, t.id, member.id)).toHaveProperty('system_prompt', '內部方法');

    expect((await listOrgTemplates(db, member2.id, orgId)).find((x) => x.id === t.id)?.editable).toBe(false);
    expect((await listOrgTemplates(db, admin.id, orgId)).find((x) => x.id === t.id)?.editable).toBe(true);
    await expectStatus(updateTemplate(db, member2.id, t.id, { name: 'hack' }), 404, '找不到這個 agent');
  });

  it('建立者離開後只有管理員能改，建立者看不到內容', async () => {
    const { admin, member, orgId } = await seedOrg();
    const t = await createTemplate(db, member.id, orgInput(orgId));
    await publishTemplate(db, member.id, t.id);
    await removeMember(db, admin.id, orgId, member.id);

    await expectStatus(getTemplate(db, t.id, member.id), 404, '找不到這個 agent');
    expect((await listMyTemplates(db, member.id)).map((x) => x.id)).not.toContain(t.id);
    await expectStatus(updateTemplate(db, member.id, t.id, { name: 'hack' }), 404, '找不到這個 agent');
    await expectStatus(publishTemplate(db, member.id, t.id), 404, '找不到這個 agent');
    await expectStatus(createSkillsUploadUrl(db, member.id, t.id), 404, '找不到這個 agent');
    expect((await updateTemplate(db, admin.id, t.id, { system_prompt: '交接後的方法' })).system_prompt).toBe('交接後的方法');
  });

  it('需要核准時成員上架變待核准，管理員核准後上架', async () => {
    const { admin, member, member2, orgId } = await seedOrg();
    await updateOrg(db, admin.id, orgId, { require_template_approval: true });
    const t = await createTemplate(db, member.id, orgInput(orgId));
    expect((await publishTemplate(db, member.id, t.id)).status).toBe('pending');
    // 待核准時再按一次上架，仍是待核准
    expect((await publishTemplate(db, member.id, t.id)).status).toBe('pending');
    expect((await listOrgTemplates(db, member2.id, orgId)).map((x) => x.id)).not.toContain(t.id);
    expect((await listOrgTemplates(db, admin.id, orgId)).find((x) => x.id === t.id)?.status).toBe('pending');
    await expectStatus(getTemplate(db, t.id, member2.id), 404, '找不到這個 agent');
    await expectStatus(reviewTemplate(db, member.id, t.id, 'approve'), 403, '只有管理員可以這樣做');

    expect((await reviewTemplate(db, admin.id, t.id, 'approve')).status).toBe('published');
    expect((await listOrgTemplates(db, member2.id, orgId)).map((x) => x.id)).toContain(t.id);
    expect((await publishTemplate(db, member.id, t.id)).status).toBe('published');
    await expectStatus(reviewTemplate(db, admin.id, t.id, 'approve'), 409, '這個顧問不在待核准狀態，請重新整理');

    const rejected = await createTemplate(db, member.id, orgInput(orgId));
    await publishTemplate(db, member.id, rejected.id);
    expect((await reviewTemplate(db, admin.id, rejected.id, 'reject')).status).toBe('draft');
  });

  it('管理員上架不需要核准', async () => {
    const { admin, orgId } = await seedOrg();
    await updateOrg(db, admin.id, orgId, { require_template_approval: true });
    const t = await createTemplate(db, admin.id, orgInput(orgId));
    expect((await publishTemplate(db, admin.id, t.id)).status).toBe('published');
  });

  it('下架只限組織範本', async () => {
    const { member, member2, orgId } = await seedOrg();
    const t = await createTemplate(db, member.id, orgInput(orgId));
    await publishTemplate(db, member.id, t.id);
    expect((await unpublishTemplate(db, member.id, t.id)).status).toBe('draft');
    expect((await listOrgTemplates(db, member2.id, orgId)).map((x) => x.id)).not.toContain(t.id);

    const pub = await createTemplate(db, member.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    await publishTemplate(db, member.id, pub.id);
    await expectStatus(unpublishTemplate(db, member.id, pub.id), 400, '公開市集的顧問目前不能下架');
  });

  it('非成員不能在組織裡建範本', async () => {
    const { outsider, orgId } = await seedOrg();
    await expectStatus(createTemplate(db, outsider.id, orgInput(orgId)), 404, '找不到這個組織');
  });
});
