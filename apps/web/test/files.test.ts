import { describe, expect, it } from 'vitest';
import { createFileUploadUrl, listFiles, storageFileName } from '@/lib/services/files';
import { createProject } from '@/lib/services/projects';
import { seedUser, testDb } from './helpers';

const db = testDb();

describe('storageFileName', () => {
  it('去掉路徑，只留 Storage 接受的字元', () => {
    expect(storageFileName('../../etc/passwd')).toBe('passwd');
    expect(storageFileName('Q3 report (final).pdf')).toBe('Q3_report_(final).pdf');
    expect(storageFileName('財報.pdf')).toMatch(/^file_\d+\.pdf$/);
    expect(storageFileName('2026財報v2.xlsx')).toBe('2026__v2.xlsx');
  });
});

describe('files service', () => {
  it('取得上傳網址、上傳後列得出來；別人的專案 404', async () => {
    const owner = await seedUser(db);
    const other = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    const { signedUrl, name } = await createFileUploadUrl(db, owner.id, p.id, 'brief.md');
    expect(name).toBe('brief.md');
    const res = await fetch(signedUrl, { method: 'PUT', body: new Blob(['# 需求']), headers: { 'content-type': 'text/markdown', 'x-upsert': 'true' } });
    expect(res.ok).toBe(true);
    expect((await listFiles(db, owner.id, p.id)).map((f) => f.name)).toEqual(['brief.md']);
    const e = await listFiles(db, other.id, p.id).catch((err) => err);
    expect(e.status).toBe(404);
  });
});
