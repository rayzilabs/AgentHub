import { describe, expect, it, onTestFinished } from 'vitest';
import { UPLOAD_FOLDER_NAME } from '@/lib/file-tree';
import { getProjectTree, removeProjectStorage } from '@/lib/services/files';
import { createProject } from '@/lib/services/projects';
import { migrateProjectFiles } from '../scripts/migrate-project-files';
import { seedUser, testDb } from './helpers';

const db = testDb();
const bucket = () => db.storage.from('project-files');

describe('migrateProjectFiles', () => {
  it('舊檔案搬進「我上傳的」', async () => {
    const owner = await seedUser(db);
    const p = (await createProject(db, owner.id, 'p')).id;
    onTestFinished(() => removeProjectStorage(db, p));
    for (const name of ['brief.md', 'file_123.pdf']) {
      const { error } = await bucket().upload(`${p}/${name}`, new Blob([`內容 ${name}`]), { contentType: 'text/plain' });
      expect(error).toBeNull();
    }

    expect(await migrateProjectFiles(db, p)).toEqual({ moved: 2 });

    const tree = await getProjectTree(db, owner.id, p);
    const folder = tree.folders.find((f) => f.name === UPLOAD_FOLDER_NAME && f.parent_id === null);
    expect(folder).toBeTruthy();
    const inFolder = tree.files.filter((f) => f.folder_id === folder!.id);
    expect(inFolder.map((f) => f.name).sort()).toEqual(['brief.md', 'file_123.pdf']);
    expect(inFolder.every((f) => f.source === 'user')).toBe(true);

    const { data, error } = await bucket().list(p);
    expect(error).toBeNull();
    expect(data!.map((o) => ({ name: o.name, isFolder: o.id === null }))).toEqual([{ name: 'files', isFolder: true }]);

    expect(await migrateProjectFiles(db, p)).toEqual({ moved: 0 });
  });
});
