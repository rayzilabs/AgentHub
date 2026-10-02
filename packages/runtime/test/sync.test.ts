import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { SyncError } from '../src/errors';
import { agentDir, skillsDir, syncSharedFiles, syncSkills } from '../src/sync';
import { testDb, tmpRoots, uploadSkillsZip } from './helpers';

const db = testDb();
const exists = (p: string) => stat(p).then(() => true, () => false);

describe('syncSkills', () => {
  it('下載並解壓 skills', async () => {
    const { agentsRoot } = await tmpRoots();
    const zipPath = await uploadSkillsZip(db, { 'contract/SKILL.md': '# 審合約', 'contract/check.sh': 'echo ok' });
    const id = randomUUID();
    await syncSkills(db, agentsRoot, { id, skills_zip_path: zipPath });
    expect(await readFile(path.join(skillsDir(agentsRoot, id), 'contract/SKILL.md'), 'utf8')).toBe('# 審合約');
    expect(await readFile(path.join(skillsDir(agentsRoot, id), 'contract/check.sh'), 'utf8')).toBe('echo ok');
  });

  it('版本相同時不重新下載', async () => {
    const { agentsRoot } = await tmpRoots();
    const zipPath = await uploadSkillsZip(db, { 'a/SKILL.md': 'A' });
    const id = randomUUID();
    await syncSkills(db, agentsRoot, { id, skills_zip_path: zipPath });
    const sentinel = path.join(skillsDir(agentsRoot, id), 'sentinel.txt');
    await writeFile(sentinel, 'keep');
    await syncSkills(db, agentsRoot, { id, skills_zip_path: zipPath });
    expect(await exists(sentinel)).toBe(true);
  });

  it('版本改變時清掉舊檔', async () => {
    const { agentsRoot } = await tmpRoots();
    const id = randomUUID();
    await syncSkills(db, agentsRoot, { id, skills_zip_path: await uploadSkillsZip(db, { 'old/SKILL.md': 'old' }) });
    await syncSkills(db, agentsRoot, { id, skills_zip_path: await uploadSkillsZip(db, { 'new/SKILL.md': 'new' }) });
    expect(await exists(path.join(skillsDir(agentsRoot, id), 'old/SKILL.md'))).toBe(false);
    expect(await readFile(path.join(skillsDir(agentsRoot, id), 'new/SKILL.md'), 'utf8')).toBe('new');
  });

  it('zip 內含 ../ 路徑時拒絕，不寫到工作目錄外', async () => {
    const { agentsRoot } = await tmpRoots();
    const zip = zipSync({ '../evil.txt': strToU8('x') });
    const objectPath = `${randomUUID()}/evil.zip`;
    await db.storage.from('skills').upload(objectPath, zip, { contentType: 'application/zip' });
    const id = randomUUID();
    await expect(syncSkills(db, agentsRoot, { id, skills_zip_path: objectPath })).rejects.toBeInstanceOf(SyncError);
    expect(await exists(path.join(agentDir(agentsRoot, id), 'evil.txt'))).toBe(false);
  });

  it('沒有 skill 時只建立工作目錄', async () => {
    const { agentsRoot } = await tmpRoots();
    const id = randomUUID();
    await syncSkills(db, agentsRoot, { id, skills_zip_path: null });
    expect(await exists(agentDir(agentsRoot, id))).toBe(true);
  });

  it('Storage 找不到 zip 時丟出 SyncError', async () => {
    const { agentsRoot } = await tmpRoots();
    await expect(
      syncSkills(db, agentsRoot, { id: randomUUID(), skills_zip_path: `${randomUUID()}/missing.zip` }),
    ).rejects.toBeInstanceOf(SyncError);
  });
});

describe('syncSharedFiles', () => {
  it('新增、更新、刪除都會反映到本機', async () => {
    const { sharedRoot } = await tmpRoots();
    const projectId = randomUUID();
    const bucket = db.storage.from('project-files');
    await bucket.upload(`${projectId}/a.txt`, 'A1', { contentType: 'text/plain' });
    await bucket.upload(`${projectId}/b.txt`, 'B1', { contentType: 'text/plain' });

    expect((await syncSharedFiles(db, projectId, sharedRoot)).sort()).toEqual(['a.txt', 'b.txt']);
    expect(await readFile(path.join(sharedRoot, 'a.txt'), 'utf8')).toBe('A1');

    await new Promise((r) => setTimeout(r, 1100));
    await bucket.upload(`${projectId}/a.txt`, 'A2', { contentType: 'text/plain', upsert: true });
    await bucket.remove([`${projectId}/b.txt`]);

    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual(['a.txt']);
    expect(await readFile(path.join(sharedRoot, 'a.txt'), 'utf8')).toBe('A2');
    expect(await exists(path.join(sharedRoot, 'b.txt'))).toBe(false);
  });

  it('同步紀錄檔損毀時當作沒有紀錄，重新下載全部檔案', async () => {
    const { sharedRoot } = await tmpRoots();
    const projectId = randomUUID();
    await db.storage.from('project-files').upload(`${projectId}/a.txt`, 'A1', { contentType: 'text/plain' });
    await syncSharedFiles(db, projectId, sharedRoot);
    await writeFile(path.join(sharedRoot, 'a.txt'), '本機被改掉');
    await writeFile(path.join(sharedRoot, '.sync.json'), '{壞掉的 json');

    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual(['a.txt']);
    expect(await readFile(path.join(sharedRoot, 'a.txt'), 'utf8')).toBe('A1');
  });

  it('專案沒有檔案時回傳空陣列', async () => {
    const { sharedRoot } = await tmpRoots();
    expect(await syncSharedFiles(db, randomUUID(), sharedRoot)).toEqual([]);
  });
});
