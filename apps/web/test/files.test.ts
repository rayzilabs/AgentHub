import { describe, expect, it } from 'vitest';
import {
  collectFileIds,
  completeUpload,
  createFolder,
  createUploadUrl,
  deleteFile,
  deleteFolder,
  entryName,
  fileDownloadUrl,
  getProjectTree,
  updateFile,
  updateFolder,
} from '@/lib/services/files';
import { createProject } from '@/lib/services/projects';
import type { Db } from '@/lib/supabase/admin';
import { seedUser, testDb } from './helpers';

const db = testDb();

async function uploadVia(signedUrl: string, text: string) {
  const res = await fetch(signedUrl, { method: 'PUT', body: new Blob([text]), headers: { 'content-type': 'text/plain' } });
  expect(res.ok).toBe(true);
}

async function upload(d: Db, userId: string, projectId: string, name: string, folderId: string | null, text = 'hello') {
  const { fileId, signedUrl } = await createUploadUrl(d, userId, projectId);
  await uploadVia(signedUrl, text);
  return completeUpload(d, userId, projectId, { fileId, folderId, name });
}

async function setup() {
  const owner = await seedUser(db);
  const p = await createProject(db, owner.id, 'p');
  return { owner, p };
}

describe('files service', () => {
  it('上傳到根目錄會放進「我上傳的」，中文檔名保留', async () => {
    const { owner, p } = await setup();
    const bytes = new TextEncoder().encode('財報內容').length;
    await upload(db, owner.id, p.id, '財報 2026.pdf', null, '財報內容');
    const tree = await getProjectTree(db, owner.id, p.id);
    const folder = tree.folders.find((f) => f.name === '我上傳的');
    expect(folder).toBeTruthy();
    expect(tree.files).toHaveLength(1);
    expect(tree.files[0]).toMatchObject({ name: '財報 2026.pdf', size: bytes, folder_id: folder!.id });
  });

  it('同名上傳加序號', async () => {
    const { owner, p } = await setup();
    await upload(db, owner.id, p.id, 'brief.md', null);
    await upload(db, owner.id, p.id, 'brief.md', null);
    const tree = await getProjectTree(db, owner.id, p.id);
    expect(tree.files.map((f) => f.name).sort()).toEqual(['brief (2).md', 'brief.md']);
  });

  it('改名撞名回 409、搬移成功', async () => {
    const { owner, p } = await setup();
    await upload(db, owner.id, p.id, 'brief.md', null);
    const second = await upload(db, owner.id, p.id, 'brief.md', null);
    const e = await updateFile(db, owner.id, p.id, second.id, { name: 'brief.md' }).catch((err) => err);
    expect(e.status).toBe(409);
    const archive = await createFolder(db, owner.id, p.id, { name: '封存', parentId: null });
    await updateFile(db, owner.id, p.id, second.id, { folderId: archive.id });
    const tree = await getProjectTree(db, owner.id, p.id);
    expect(tree.files.find((f) => f.id === second.id)?.folder_id).toBe(archive.id);
  });

  it('資料夾不能搬進自己裡面', async () => {
    const { owner, p } = await setup();
    const a = await createFolder(db, owner.id, p.id, { name: 'A', parentId: null });
    const b = await createFolder(db, owner.id, p.id, { name: 'B', parentId: a.id });
    const e = await updateFolder(db, owner.id, p.id, a.id, { parentId: b.id }).catch((err) => err);
    expect(e.status).toBe(400);
    const self = await updateFolder(db, owner.id, p.id, a.id, { parentId: a.id }).catch((err) => err);
    expect(self.status).toBe(400);
  });

  it('刪資料夾連子孫檔案的 storage 一起刪', async () => {
    const { owner, p } = await setup();
    const a = await createFolder(db, owner.id, p.id, { name: 'A', parentId: null });
    const b = await createFolder(db, owner.id, p.id, { name: 'B', parentId: a.id });
    const f1 = await upload(db, owner.id, p.id, 'one.txt', a.id);
    const f2 = await upload(db, owner.id, p.id, 'two.txt', b.id);
    await deleteFolder(db, owner.id, p.id, a.id);
    const tree = await getProjectTree(db, owner.id, p.id);
    expect(tree.folders.filter((f) => f.name !== '我上傳的')).toEqual([]);
    expect(tree.files).toEqual([]);
    const { data } = await db.storage.from('project-files').list(`${p.id}/files`);
    const names = (data ?? []).map((o) => o.name);
    expect(names).not.toContain(f1.id);
    expect(names).not.toContain(f2.id);
  });

  it('collectFileIds 分頁與分批後仍收齊所有檔案', async () => {
    const { owner, p } = await setup();
    const a = await createFolder(db, owner.id, p.id, { name: 'A', parentId: null });
    const b = await createFolder(db, owner.id, p.id, { name: 'B', parentId: null });
    const made = [
      await upload(db, owner.id, p.id, '1.txt', a.id),
      await upload(db, owner.id, p.id, '2.txt', a.id),
      await upload(db, owner.id, p.id, '3.txt', a.id),
      await upload(db, owner.id, p.id, '4.txt', b.id),
    ];
    const ids = await collectFileIds(db, p.id, [a.id, b.id], 2, 1);
    expect(ids.sort()).toEqual(made.map((f) => f.id).sort());
  });

  it('下載已刪除的檔案回 404', async () => {
    const { owner, p } = await setup();
    const f = await upload(db, owner.id, p.id, 'note.txt', null, '內容在這');
    const { url, name } = await fileDownloadUrl(db, owner.id, f.id);
    expect(name).toBe('note.txt');
    expect(await (await fetch(url)).text()).toBe('內容在這');
    await deleteFile(db, owner.id, p.id, f.id);
    const e = await fileDownloadUrl(db, owner.id, f.id).catch((err) => err);
    expect(e.status).toBe(404);
    expect(e.message).toBe('檔案已刪除');
  });

  it('別人的專案一律 404', async () => {
    const { owner, p } = await setup();
    const other = await seedUser(db);
    const f = await upload(db, owner.id, p.id, 'a.txt', null);
    const e1 = await getProjectTree(db, other.id, p.id).catch((err) => err);
    expect(e1.status).toBe(404);
    const e2 = await fileDownloadUrl(db, other.id, f.id).catch((err) => err);
    expect(e2.status).toBe(404);
  });
});

describe('entryName', () => {
  it('擋掉不合法名稱', () => {
    for (const bad of ['a/b', '..', '', 'x'.repeat(101)]) expect(entryName.safeParse(bad).success).toBe(false);
    expect(entryName.safeParse('週報 W43.docx').success).toBe(true);
  });
});
