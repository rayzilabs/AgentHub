import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import {
  createSkillsUploadUrl, createTemplate, getTemplate, listMyTemplates, listPublishedTemplates, publishTemplate, updateTemplate,
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

  it('還沒上傳就要求處理：400', async () => {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    await expectStatus(updateTemplate(db, creator.id, t.id, { process_upload: true }), 400, '還沒有上傳 skill 檔案');
  });
});
