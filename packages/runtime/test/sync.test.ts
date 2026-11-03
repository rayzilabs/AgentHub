import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { SyncError } from '../src/errors';
import { agentDir, skillsDir, syncSharedFiles, syncSkills } from '../src/sync';
import { runtimeDb, runtimeToken, seedProject, seedSharedFile, seedUser, testDb, tmpRoots, uploadSkillsZip } from './helpers';

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

  it('skills 放在顧問工作目錄以外（顧問不能在裡面建立或改名項目），與 agents 同一層', () => {
    expect(skillsDir('/workspace/agents', 'abc')).toBe(path.join('/workspace', 'skills', 'abc'));
    expect(skillsDir('/workspace/agents', 'abc').startsWith(agentDir('/workspace/agents', 'abc'))).toBe(false);
  });

  it('重新同步時保留 skills 目錄本身（權限由佈建設定），只換掉裡面的內容', async () => {
    const { agentsRoot } = await tmpRoots();
    const id = randomUUID();
    const dir = skillsDir(agentsRoot, id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'stale.txt'), 'old');
    await writeFile(path.join(dir, '.zip-path'), 'old.zip');
    const zipPath = await uploadSkillsZip(db, { 'a/SKILL.md': 'A' });
    const before = (await stat(dir)).ino;
    await syncSkills(db, agentsRoot, { id, skills_zip_path: zipPath });
    expect((await stat(dir)).ino).toBe(before);
    expect(await exists(path.join(dir, 'stale.txt'))).toBe(false);
    expect(await readFile(path.join(dir, 'a/SKILL.md'), 'utf8')).toBe('A');
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
  const W43 = 'ETF 資金流顧問/2026-W43/週報.docx';
  const local = (sharedRoot: string, p: string) => path.join(sharedRoot, ...p.split('/'));
  const newProject = async () => seedProject(db, await seedUser(db));

  it('依資料夾結構同步，中文路徑可用（以 runtime 帳號的權限）', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    const fileId = await seedSharedFile(db, projectId, W43, '週報內容');
    const rdb = runtimeDb(await runtimeToken(db, projectId));
    expect(await syncSharedFiles(rdb, projectId, sharedRoot)).toEqual([{ path: W43, fileId }]);
    expect(await readFile(local(sharedRoot, W43), 'utf8')).toBe('週報內容');
  });

  it('改名後舊路徑消失、新路徑出現，空資料夾被清掉', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    const fileId = await seedSharedFile(db, projectId, W43, '週報內容');
    await syncSharedFiles(db, projectId, sharedRoot);

    const { data: parent } = await db.from('project_folders').select('id').eq('project_id', projectId).eq('name', 'ETF 資金流顧問').single();
    const { data: w44, error } = await db.rpc('ensure_folder', { p_project_id: projectId, p_parent_id: parent!.id, p_name: '2026-W44' });
    if (error) throw error;
    await db.from('project_files').update({ name: '週報-定稿.docx', folder_id: w44 }).eq('id', fileId);

    const moved = 'ETF 資金流顧問/2026-W44/週報-定稿.docx';
    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual([{ path: moved, fileId }]);
    expect(await exists(local(sharedRoot, W43))).toBe(false);
    expect(await exists(path.join(sharedRoot, 'ETF 資金流顧問', '2026-W43'))).toBe(false);
    expect(await readFile(local(sharedRoot, moved), 'utf8')).toBe('週報內容');
  });

  it('顧問自己放在 /shared 的檔案不受影響；裝著顧問檔案的資料夾不會被清掉', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    const fileId = await seedSharedFile(db, projectId, W43, '週報內容');
    await mkdir(sharedRoot, { recursive: true });
    await writeFile(path.join(sharedRoot, 'notes.txt'), '顧問筆記');
    await syncSharedFiles(db, projectId, sharedRoot);
    const mine = path.join(sharedRoot, 'ETF 資金流顧問', '2026-W43', '我的草稿.md');
    await writeFile(mine, '草稿');

    await db.from('project_files').delete().eq('id', fileId);
    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual([]);
    expect(await exists(local(sharedRoot, W43))).toBe(false);
    expect(await readFile(mine, 'utf8')).toBe('草稿');
    expect(await readFile(path.join(sharedRoot, 'notes.txt'), 'utf8')).toBe('顧問筆記');
  });

  it('資料夾被換成 symlink 時不跟著寫', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    await seedSharedFile(db, projectId, W43, '週報內容');
    await syncSharedFiles(db, projectId, sharedRoot);

    const outside = (await tmpRoots()).sharedRoot;
    await mkdir(outside, { recursive: true });
    const dir = path.join(sharedRoot, 'ETF 資金流顧問');
    await rm(dir, { recursive: true });
    await symlink(outside, dir);

    await syncSharedFiles(db, projectId, sharedRoot);
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(dir)).isDirectory()).toBe(true);
    expect(await readFile(local(sharedRoot, W43), 'utf8')).toBe('週報內容');
  });

  it('fileId 沒變就不重新下載', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    await seedSharedFile(db, projectId, W43, '週報內容');
    await syncSharedFiles(db, projectId, sharedRoot);
    await writeFile(local(sharedRoot, W43), '本機改過');
    await syncSharedFiles(db, projectId, sharedRoot);
    expect(await readFile(local(sharedRoot, W43), 'utf8')).toBe('本機改過');
  });

  it('同步紀錄被竄改成含路徑的檔名：不會刪到共用資料夾以外的檔案', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    await mkdir(sharedRoot, { recursive: true });
    const outside = path.join(sharedRoot, '..', 'outside.txt');
    await writeFile(outside, 'keep');
    await writeFile(path.join(sharedRoot, '.sync.json'), JSON.stringify({ '../outside.txt': 'x', 'a/../../outside.txt': 'x' }));
    await syncSharedFiles(db, projectId, sharedRoot);
    expect(await readFile(outside, 'utf8')).toBe('keep');
  });

  it('同步紀錄指到被換成 symlink 的資料夾：不會刪到共用資料夾以外的檔案', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    const outside = (await tmpRoots()).sharedRoot;
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'keep');
    await mkdir(sharedRoot, { recursive: true });
    await symlink(outside, path.join(sharedRoot, 'evil'));
    await writeFile(path.join(sharedRoot, '.sync.json'), JSON.stringify({ 'evil/secret.txt': 'x' }));
    await syncSharedFiles(db, projectId, sharedRoot);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('keep');
  });

  it('同步紀錄被換成 symlink：不會跟著寫到別的檔案', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    await mkdir(sharedRoot, { recursive: true });
    const outside = path.join(sharedRoot, '..', 'target.txt');
    await writeFile(outside, 'keep');
    await symlink(outside, path.join(sharedRoot, '.sync.json'));
    await syncSharedFiles(db, projectId, sharedRoot);
    expect(await readFile(outside, 'utf8')).toBe('keep');
    expect((await lstat(path.join(sharedRoot, '.sync.json'))).isSymbolicLink()).toBe(false);
  });

  it('專案檔案同步時，目標檔若是唯讀（agent 建立的同名檔）也能覆蓋', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    await seedSharedFile(db, projectId, '資料/a.txt', 'new');
    await mkdir(path.join(sharedRoot, '資料'), { recursive: true });
    await writeFile(path.join(sharedRoot, '資料', 'a.txt'), 'old');
    await chmod(path.join(sharedRoot, '資料', 'a.txt'), 0o444);
    await syncSharedFiles(db, projectId, sharedRoot);
    expect(await readFile(path.join(sharedRoot, '資料', 'a.txt'), 'utf8')).toBe('new');
  });

  it('新增、刪除都會反映到本機', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual([{ path: '資料/a.txt', fileId: a }]);

    const b = await seedSharedFile(db, projectId, '資料/b.txt', 'B1');
    await db.from('project_files').delete().eq('id', a);
    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual([{ path: '資料/b.txt', fileId: b }]);
    expect(await exists(path.join(sharedRoot, '資料', 'a.txt'))).toBe(false);
    expect(await readFile(path.join(sharedRoot, '資料', 'b.txt'), 'utf8')).toBe('B1');
  });

  it('同步紀錄檔損毀時當作沒有紀錄，重新下載全部檔案', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    await syncSharedFiles(db, projectId, sharedRoot);
    await writeFile(path.join(sharedRoot, '資料', 'a.txt'), '本機被改掉');
    await writeFile(path.join(sharedRoot, '.sync.json'), '{壞掉的 json');

    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual([{ path: '資料/a.txt', fileId: a }]);
    expect(await readFile(path.join(sharedRoot, '資料', 'a.txt'), 'utf8')).toBe('A1');
  });

  it('舊制放在專案根目錄的物件不再同步', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    await db.storage.from('project-files').upload(`${projectId}/legacy.txt`, 'old', { contentType: 'text/plain' });
    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual([]);
    expect(await exists(path.join(sharedRoot, 'legacy.txt'))).toBe(false);
  });

  it('同一層有同名的檔案與資料夾時略過該檔案，重複同步也不出錯', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    await seedSharedFile(db, projectId, 'A/b', '檔案');
    const c = await seedSharedFile(db, projectId, 'A/b/c.txt', '資料夾裡的檔案');
    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual([{ path: 'A/b/c.txt', fileId: c }]);
    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual([{ path: 'A/b/c.txt', fileId: c }]);
    expect(await readFile(path.join(sharedRoot, 'A', 'b', 'c.txt'), 'utf8')).toBe('資料夾裡的檔案');
  });

  it('與同步紀錄檔同名的資料夾略過，不蓋掉紀錄檔', async () => {
    const projectId = await newProject();
    const { sharedRoot } = await tmpRoots();
    await seedSharedFile(db, projectId, '.sync.json/x.txt', 'x');
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual([{ path: '資料/a.txt', fileId: a }]);
    expect((await lstat(path.join(sharedRoot, '.sync.json'))).isFile()).toBe(true);
  });

  it('專案沒有檔案時回傳空陣列', async () => {
    const { sharedRoot } = await tmpRoots();
    expect(await syncSharedFiles(db, await newProject(), sharedRoot)).toEqual([]);
  });
});
