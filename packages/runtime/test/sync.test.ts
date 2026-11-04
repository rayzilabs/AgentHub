import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import { SyncError } from '../src/errors';
import { createSandbox, type Sandbox } from '../src/sandbox';
import { agentDir, skillsDir, syncSharedFiles, syncSkills } from '../src/sync';
import {
  type Roots, runtimeDb, runtimeToken, seedProject, seedSharedFile, seedUser, testDb, tmpRoots, uploadSkillsZip,
} from './helpers';

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
  const sandbox = createSandbox();
  const sync = (d: Db, projectId: string, roots: Roots) =>
    syncSharedFiles(d, projectId, roots.sharedRoot, { sandbox, statePath: roots.syncState });
  const must = ({ error }: { error: unknown }) => {
    if (error) throw error;
  };

  it('依資料夾結構同步，中文路徑可用（以 runtime 帳號的權限）；同步紀錄不放在共用資料夾', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const fileId = await seedSharedFile(db, projectId, W43, '週報內容');
    const rdb = runtimeDb(await runtimeToken(db, projectId));
    expect(await sync(rdb, projectId, roots)).toEqual([{ path: W43, fileId }]);
    expect(await readFile(local(roots.sharedRoot, W43), 'utf8')).toBe('週報內容');
    expect(await readdir(roots.sharedRoot)).toEqual(['ETF 資金流顧問']);
    expect(JSON.parse(await readFile(roots.syncState, 'utf8'))).toEqual({ [W43]: fileId });
  });

  it('改名後舊路徑消失、新路徑出現，空資料夾被清掉', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const fileId = await seedSharedFile(db, projectId, W43, '週報內容');
    await sync(db, projectId, roots);

    const { data: parent, error } = await db.from('project_folders').select('id').eq('project_id', projectId).eq('name', 'ETF 資金流顧問').single();
    if (error) throw error;
    const { data: w44, error: folderError } = await db.rpc('ensure_folder', { p_project_id: projectId, p_parent_id: parent.id, p_name: '2026-W44' });
    if (folderError) throw folderError;
    must(await db.from('project_files').update({ name: '週報-定稿.docx', folder_id: w44 }).eq('id', fileId));

    const moved = 'ETF 資金流顧問/2026-W44/週報-定稿.docx';
    expect(await sync(db, projectId, roots)).toEqual([{ path: moved, fileId }]);
    expect(await exists(local(roots.sharedRoot, W43))).toBe(false);
    expect(await exists(path.join(roots.sharedRoot, 'ETF 資金流顧問', '2026-W43'))).toBe(false);
    expect(await readFile(local(roots.sharedRoot, moved), 'utf8')).toBe('週報內容');
  });

  it('顧問自己放在 /shared 的檔案不受影響；裝著顧問檔案的資料夾不會被清掉', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const fileId = await seedSharedFile(db, projectId, W43, '週報內容');
    await mkdir(roots.sharedRoot, { recursive: true });
    await writeFile(path.join(roots.sharedRoot, 'notes.txt'), '顧問筆記');
    await sync(db, projectId, roots);
    const mine = path.join(roots.sharedRoot, 'ETF 資金流顧問', '2026-W43', '我的草稿.md');
    await writeFile(mine, '草稿');

    must(await db.from('project_files').delete().eq('id', fileId));
    expect(await sync(db, projectId, roots)).toEqual([]);
    expect(await exists(local(roots.sharedRoot, W43))).toBe(false);
    expect(await readFile(mine, 'utf8')).toBe('草稿');
    expect(await readFile(path.join(roots.sharedRoot, 'notes.txt'), 'utf8')).toBe('顧問筆記');
  });

  it('資料夾被換成 symlink 時不跟著寫', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    await seedSharedFile(db, projectId, W43, '週報內容');
    await sync(db, projectId, roots);

    const outside = (await tmpRoots()).sharedRoot;
    await mkdir(outside, { recursive: true });
    const dir = path.join(roots.sharedRoot, 'ETF 資金流顧問');
    await rm(dir, { recursive: true });
    await symlink(outside, dir);

    await sync(db, projectId, roots);
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(dir)).isDirectory()).toBe(true);
    expect(await readFile(local(roots.sharedRoot, W43), 'utf8')).toBe('週報內容');
  });

  it('資料夾被換成 symlink 後雲端檔案被刪：不會刪到 symlink 指向的檔案', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const fileId = await seedSharedFile(db, projectId, '資料/secret.txt', '雲端版本');
    await sync(db, projectId, roots);

    const outside = (await tmpRoots()).sharedRoot;
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'keep');
    await rm(path.join(roots.sharedRoot, '資料'), { recursive: true });
    await symlink(outside, path.join(roots.sharedRoot, '資料'));
    must(await db.from('project_files').delete().eq('id', fileId));

    expect(await sync(db, projectId, roots)).toEqual([]);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('keep');
  });

  it('fileId 沒變就不重新下載', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    await seedSharedFile(db, projectId, W43, '週報內容');
    await sync(db, projectId, roots);
    await writeFile(local(roots.sharedRoot, W43), '本機改過');
    await sync(db, projectId, roots);
    expect(await readFile(local(roots.sharedRoot, W43), 'utf8')).toBe('本機改過');
  });

  it('同一路徑換成新的檔案（刪掉再上傳同名檔）時重新下載', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a1 = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    await sync(db, projectId, roots);
    must(await db.from('project_files').delete().eq('id', a1));
    const a2 = await seedSharedFile(db, projectId, '資料/a.txt', 'A2');

    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/a.txt', fileId: a2 }]);
    expect(await readFile(path.join(roots.sharedRoot, '資料', 'a.txt'), 'utf8')).toBe('A2');
  });

  it('二進位內容逐位元組相同', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const bytes = new Uint8Array(256).map((_, i) => i);
    await seedSharedFile(db, projectId, '資料/all.bin', bytes);
    await sync(db, projectId, roots);
    expect(Buffer.from(await readFile(path.join(roots.sharedRoot, '資料', 'all.bin'))).equals(Buffer.from(bytes))).toBe(true);
  });

  it('同步紀錄被竄改成含路徑的檔名：不會刪到共用資料夾以外的檔案', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    await mkdir(roots.sharedRoot, { recursive: true });
    const outside = path.join(roots.sharedRoot, '..', 'outside.txt');
    await writeFile(outside, 'keep');
    await mkdir(path.dirname(roots.syncState), { recursive: true });
    await writeFile(roots.syncState, JSON.stringify({ '../outside.txt': 'x', 'a/../../outside.txt': 'x' }));
    await sync(db, projectId, roots);
    expect(await readFile(outside, 'utf8')).toBe('keep');
  });

  it('專案檔案同步時，目標檔若是唯讀（agent 建立的同名檔）也能覆蓋', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    await seedSharedFile(db, projectId, '資料/a.txt', 'new');
    await mkdir(path.join(roots.sharedRoot, '資料'), { recursive: true });
    await writeFile(path.join(roots.sharedRoot, '資料', 'a.txt'), 'old');
    await chmod(path.join(roots.sharedRoot, '資料', 'a.txt'), 0o444);
    await sync(db, projectId, roots);
    expect(await readFile(path.join(roots.sharedRoot, '資料', 'a.txt'), 'utf8')).toBe('new');
  });

  it('新增、刪除都會反映到本機', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/a.txt', fileId: a }]);

    const b = await seedSharedFile(db, projectId, '資料/b.txt', 'B1');
    must(await db.from('project_files').delete().eq('id', a));
    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/b.txt', fileId: b }]);
    expect(await exists(path.join(roots.sharedRoot, '資料', 'a.txt'))).toBe(false);
    expect(await readFile(path.join(roots.sharedRoot, '資料', 'b.txt'), 'utf8')).toBe('B1');
  });

  it('同步紀錄檔損毀時當作沒有紀錄，重新下載全部檔案', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    await sync(db, projectId, roots);
    await writeFile(path.join(roots.sharedRoot, '資料', 'a.txt'), '本機被改掉');
    await writeFile(roots.syncState, '{壞掉的 json');

    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/a.txt', fileId: a }]);
    expect(await readFile(path.join(roots.sharedRoot, '資料', 'a.txt'), 'utf8')).toBe('A1');
  });

  it('單一檔案同步失敗只略過那一個，其他照常、之後的同步也不會失敗', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    const b = await seedSharedFile(db, projectId, '資料/b.txt', 'B1');
    const missing = await seedSharedFile(db, projectId, '資料/c.txt', 'C1');
    must(await db.storage.from('project-files').remove([`${projectId}/files/${missing}`]));
    // 顧問在檔案的位置放了一個非空的資料夾
    await mkdir(path.join(roots.sharedRoot, '資料', 'a.txt'), { recursive: true });
    await writeFile(path.join(roots.sharedRoot, '資料', 'a.txt', 'x'), 'x');

    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/b.txt', fileId: b }]);
    expect(await readFile(path.join(roots.sharedRoot, '資料', 'b.txt'), 'utf8')).toBe('B1');
    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/b.txt', fileId: b }]);
  });

  it('名稱超過 255 bytes（中文 100 字以內也可能超過）的檔案略過，不讓同步失敗', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const long = `${'週'.repeat(90)}.txt`;
    expect(long.length).toBeLessThanOrEqual(100);
    await seedSharedFile(db, projectId, `資料/${long}`, 'x');
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/a.txt', fileId: a }]);
    expect(await exists(path.join(roots.sharedRoot, '資料', long))).toBe(false);
  });

  it('舊制放在專案根目錄的物件不再同步', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    await db.storage.from('project-files').upload(`${projectId}/legacy.txt`, 'old', { contentType: 'text/plain' });
    expect(await sync(db, projectId, roots)).toEqual([]);
    expect(await exists(path.join(roots.sharedRoot, 'legacy.txt'))).toBe(false);
  });

  it('同一層有同名的檔案與資料夾時略過該檔案，重複同步也不出錯', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    await seedSharedFile(db, projectId, 'A/b', '檔案');
    const c = await seedSharedFile(db, projectId, 'A/b/c.txt', '資料夾裡的檔案');
    expect(await sync(db, projectId, roots)).toEqual([{ path: 'A/b/c.txt', fileId: c }]);
    expect(await sync(db, projectId, roots)).toEqual([{ path: 'A/b/c.txt', fileId: c }]);
    expect(await readFile(path.join(roots.sharedRoot, 'A', 'b', 'c.txt'), 'utf8')).toBe('資料夾裡的檔案');
  });

  it('專案沒有檔案時回傳空陣列', async () => {
    expect(await sync(db, await newProject(), await tmpRoots())).toEqual([]);
  });

  /** 讓符合條件的沙盒指令失敗（模擬權限不足、逾時這類寫入或刪除失敗） */
  const failing = (match: (argv: string[]) => boolean): Sandbox => ({
    ...sandbox,
    spawn: (argv, opts) => sandbox.spawn(match(argv) ? ['bash', '-c', 'echo 模擬失敗 >&2; exit 1'] : argv, opts),
  });
  const isWrite = (argv: string[]) => argv.some((a) => a.includes('mktemp'));
  const isDelete = (argv: string[]) => argv.some((a) => a.includes('rmdir'));
  const syncWith = (projectId: string, roots: Roots, s: Sandbox) =>
    syncSharedFiles(db, projectId, roots.sharedRoot, { sandbox: s, statePath: roots.syncState });
  const state = async (roots: Roots) => JSON.parse(await readFile(roots.syncState, 'utf8')) as Record<string, string>;
  const leftovers = async (dir: string) => (await readdir(dir)).filter((n) => n.startsWith('.agenthub-sync.'));

  it('寫入失敗的路徑仍留在同步紀錄：下次重寫，雲端刪掉後本機的舊副本也會清掉', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a1 = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    await sync(db, projectId, roots);
    must(await db.from('project_files').delete().eq('id', a1));
    const a2 = await seedSharedFile(db, projectId, '資料/a.txt', 'A2');

    expect(await syncWith(projectId, roots, failing(isWrite))).toEqual([]);
    expect(await readFile(path.join(roots.sharedRoot, '資料', 'a.txt'), 'utf8')).toBe('A1');
    expect(await state(roots)).toEqual({ '資料/a.txt': '' });

    must(await db.from('project_files').delete().eq('id', a2));
    expect(await sync(db, projectId, roots)).toEqual([]);
    expect(await exists(path.join(roots.sharedRoot, '資料', 'a.txt'))).toBe(false);
    expect(await state(roots)).toEqual({});
  });

  it('寫入失敗後下次同步會重寫（即使雲端的檔案沒變）', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    expect(await syncWith(projectId, roots, failing(isWrite))).toEqual([]);
    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/a.txt', fileId: a }]);
    expect(await readFile(path.join(roots.sharedRoot, '資料', 'a.txt'), 'utf8')).toBe('A1');
  });

  it('總時間用完時略過剩下要寫入的檔案（留在紀錄），下次同步補上', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    const io = { sandbox, statePath: roots.syncState };
    expect(await syncSharedFiles(db, projectId, roots.sharedRoot, { ...io, budgetMs: 0 })).toEqual([]);
    expect(await exists(path.join(roots.sharedRoot, '資料', 'a.txt'))).toBe(false);
    expect(await state(roots)).toEqual({ '資料/a.txt': '' });
    expect(await syncSharedFiles(db, projectId, roots.sharedRoot, io)).toEqual([{ path: '資料/a.txt', fileId: a }]);
    expect(await readFile(path.join(roots.sharedRoot, '資料', 'a.txt'), 'utf8')).toBe('A1');
  });

  it('刪除失敗的路徑保留在同步紀錄，下次同步再刪', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    await sync(db, projectId, roots);
    must(await db.from('project_files').delete().eq('id', a));

    expect(await syncWith(projectId, roots, failing(isDelete))).toEqual([]);
    expect(await exists(path.join(roots.sharedRoot, '資料', 'a.txt'))).toBe(true);
    expect(await state(roots)).toEqual({ '資料/a.txt': a });

    expect(await sync(db, projectId, roots)).toEqual([]);
    expect(await exists(path.join(roots.sharedRoot, '資料', 'a.txt'))).toBe(false);
    expect(await state(roots)).toEqual({});
  });

  it('目標被換成 symlink：整個換成一般檔案，不寫到 symlink 指向的檔案；不留暫存檔', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'new');
    const outside = path.join((await tmpRoots()).sharedRoot, 'target.txt');
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, 'keep');
    await mkdir(path.join(roots.sharedRoot, '資料'), { recursive: true });
    await symlink(outside, path.join(roots.sharedRoot, '資料', 'a.txt'));

    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/a.txt', fileId: a }]);
    expect((await lstat(path.join(roots.sharedRoot, '資料', 'a.txt'))).isFile()).toBe(true);
    expect(await readFile(path.join(roots.sharedRoot, '資料', 'a.txt'), 'utf8')).toBe('new');
    expect(await readFile(outside, 'utf8')).toBe('keep');
    expect(await leftovers(path.join(roots.sharedRoot, '資料'))).toEqual([]);
  });

  it('目標位置是資料夾時寫入失敗：資料夾不動、暫存檔清掉，資料夾移走後下次同步寫入', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    const target = path.join(roots.sharedRoot, '資料', 'a.txt');
    await mkdir(target, { recursive: true });

    expect(await sync(db, projectId, roots)).toEqual([]);
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect(await leftovers(path.join(roots.sharedRoot, '資料'))).toEqual([]);

    await rm(target, { recursive: true });
    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/a.txt', fileId: a }]);
    expect(await readFile(target, 'utf8')).toBe('A1');
  });

  it.skipIf(process.platform === 'win32')('寫入的檔案權限與直接建立的檔案相同（其他顧問讀得到）', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    await sync(db, projectId, roots);
    const umask = process.umask();
    expect((await stat(path.join(roots.sharedRoot, '資料', 'a.txt'))).mode & 0o777).toBe(0o666 & ~umask);
  });

  // Windows（Git Bash）的 FIFO 是模擬的：Node 看不到，mv 也蓋不掉，只能在 Linux／Sprite 上驗
  it.skipIf(process.platform === 'win32')('目標被換成 FIFO 時不會卡住，照樣寫入一般檔案', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    const target = path.join(roots.sharedRoot, '資料', 'a.txt');
    await mkdir(path.dirname(target), { recursive: true });
    execFileSync('mkfifo', [target]);

    expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/a.txt', fileId: a }]);
    expect((await lstat(target)).isFile()).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('A1');
  }, 30_000);

  it.skipIf(process.platform === 'win32')('同步時顧問不停把目標換成 FIFO，同步仍會結束', async () => {
    const projectId = await newProject();
    const roots = await tmpRoots();
    const a = await seedSharedFile(db, projectId, '資料/a.txt', 'A1');
    const target = path.join(roots.sharedRoot, '資料', 'a.txt');
    await mkdir(path.dirname(target), { recursive: true });
    const racer = spawn('bash', ['-c', 'while :; do rm -f -- "$1"; mkfifo -- "$1" 2>/dev/null; done', 'racer', target], { stdio: 'ignore' });
    try {
      expect(await sync(db, projectId, roots)).toEqual([{ path: '資料/a.txt', fileId: a }]);
    } finally {
      racer.kill('SIGKILL');
    }
  }, 30_000);

  describe('舊制留在 /shared 第一層的副本', () => {
    const legacy = async (roots: Roots, state: unknown) => {
      await mkdir(roots.sharedRoot, { recursive: true });
      await writeFile(path.join(roots.sharedRoot, '.sync.json'), typeof state === 'string' ? state : JSON.stringify(state));
    };
    const at = (roots: Roots, name: string) => path.join(roots.sharedRoot, name);

    it('第一次同步刪掉紀錄裡列出的第一層一般檔案與舊紀錄；symlink、資料夾、顧問自己的檔案不碰', async () => {
      const projectId = await newProject();
      const roots = await tmpRoots();
      const fileId = await seedSharedFile(db, projectId, '我上傳的/old.txt', '雲端版本');
      const outsideRoot = (await tmpRoots()).sharedRoot;
      await mkdir(outsideRoot, { recursive: true });
      const outside = path.join(outsideRoot, 'secret.txt');
      await writeFile(outside, 'keep');
      await legacy(roots, { 'old.txt': 't', 'link.txt': 't', 'dir': 't', 'missing.txt': 't', '../escape.txt': 't' });
      await writeFile(at(roots, 'old.txt'), '舊副本');
      await symlink(outside, at(roots, 'link.txt'));
      await mkdir(at(roots, 'dir'));
      await writeFile(path.join(at(roots, 'dir'), 'x.txt'), 'x');
      await writeFile(at(roots, 'notes.txt'), '顧問筆記');
      await writeFile(path.join(roots.sharedRoot, '..', 'escape.txt'), 'keep');

      expect(await sync(db, projectId, roots)).toEqual([{ path: '我上傳的/old.txt', fileId }]);
      expect(await exists(at(roots, 'old.txt'))).toBe(false);
      expect(await exists(at(roots, '.sync.json'))).toBe(false);
      expect((await lstat(at(roots, 'link.txt'))).isSymbolicLink()).toBe(true);
      expect(await readFile(outside, 'utf8')).toBe('keep');
      expect(await readFile(path.join(at(roots, 'dir'), 'x.txt'), 'utf8')).toBe('x');
      expect(await readFile(at(roots, 'notes.txt'), 'utf8')).toBe('顧問筆記');
      expect(await readFile(path.join(roots.sharedRoot, '..', 'escape.txt'), 'utf8')).toBe('keep');
      expect(await readFile(at(roots, '我上傳的/old.txt'), 'utf8')).toBe('雲端版本');
    });

    it('舊紀錄是 symlink 時不讀也不刪', async () => {
      const projectId = await newProject();
      const roots = await tmpRoots();
      const outsideRoot = (await tmpRoots()).sharedRoot;
      await mkdir(outsideRoot, { recursive: true });
      const fake = path.join(outsideRoot, 'state.json');
      await writeFile(fake, JSON.stringify({ 'old.txt': 't' }));
      await mkdir(roots.sharedRoot, { recursive: true });
      await writeFile(at(roots, 'old.txt'), '舊副本');
      await symlink(fake, at(roots, '.sync.json'));

      await sync(db, projectId, roots);
      expect(await readFile(at(roots, 'old.txt'), 'utf8')).toBe('舊副本');
      expect((await lstat(at(roots, '.sync.json'))).isSymbolicLink()).toBe(true);
      expect(await readFile(fake, 'utf8')).toBe(JSON.stringify({ 'old.txt': 't' }));
    });

    it('舊紀錄損毀時只刪掉紀錄本身', async () => {
      const projectId = await newProject();
      const roots = await tmpRoots();
      await legacy(roots, '{壞掉的 json');
      await writeFile(at(roots, 'old.txt'), '舊副本');

      await sync(db, projectId, roots);
      expect(await exists(at(roots, '.sync.json'))).toBe(false);
      expect(await readFile(at(roots, 'old.txt'), 'utf8')).toBe('舊副本');
    });

    it('有舊副本刪不掉時保留舊紀錄，下次同步再刪', async () => {
      const projectId = await newProject();
      const roots = await tmpRoots();
      await legacy(roots, { 'old.txt': 't' });
      await writeFile(at(roots, 'old.txt'), '舊副本');

      await syncWith(projectId, roots, failing(isDelete));
      expect(await exists(at(roots, 'old.txt'))).toBe(true);
      expect(await exists(at(roots, '.sync.json'))).toBe(true);

      await sync(db, projectId, roots);
      expect(await exists(at(roots, 'old.txt'))).toBe(false);
      expect(await exists(at(roots, '.sync.json'))).toBe(false);
    });
  });
});
