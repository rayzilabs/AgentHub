import { lstat, mkdir, open, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { Db } from './db';
import { SyncError } from './errors';
import type { AgentInstance } from './types';

const SKILLS_MARKER = '.zip-path';
const SHARED_STATE = '.sync.json';

export function agentDir(agentsRoot: string, instanceId: string): string {
  return path.join(agentsRoot, instanceId);
}

/**
 * skills 放在 agents 旁邊的 skills/<id>，不在顧問可寫的工作目錄裡：
 * 顧問只能讀（佈建時設為 sprite:顧問群組 2750），無法在 runtime 解壓時把目錄換成 symlink。
 */
export function skillsDir(agentsRoot: string, instanceId: string): string {
  return path.join(path.dirname(agentsRoot), 'skills', instanceId);
}

export async function syncSkills(
  db: Db,
  agentsRoot: string,
  instance: Pick<AgentInstance, 'id' | 'skills_zip_path'>,
): Promise<void> {
  await mkdir(agentDir(agentsRoot, instance.id), { recursive: true });
  if (!instance.skills_zip_path) return;

  const dir = skillsDir(agentsRoot, instance.id);
  const current = await readFile(path.join(dir, SKILLS_MARKER), 'utf8').catch(() => null);
  if (current === instance.skills_zip_path) return;

  const { data, error } = await db.storage.from('skills').download(instance.skills_zip_path);
  if (error || !data) throw new SyncError(`無法下載 skill 檔案 ${instance.skills_zip_path}：${error?.message ?? '空檔案'}`);
  const files = unzipSync(new Uint8Array(await data.arrayBuffer()));

  const entries = Object.entries(files).filter(([name]) => !name.endsWith('/'));
  for (const [name] of entries) {
    const target = path.resolve(dir, name);
    if (!target.startsWith(dir + path.sep)) throw new SyncError(`skill zip 內含不合法的路徑：${name}`);
  }

  // 保留目錄本身（擁有者、群組與 setgid 由佈建設定），只換掉裡面的內容
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) await rm(path.join(dir, name), { recursive: true, force: true });
  for (const [name, content] of entries) {
    const target = path.resolve(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(path.join(dir, SKILLS_MARKER), instance.skills_zip_path);
}

/** 路徑的每一段都只能是單純的名稱：同步紀錄放在 agent 可寫的資料夾，內容不可信，不能讓它指到資料夾以外 */
function isPlainName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(name);
}

const isPlainPath = (p: string) => p.split('/').every(isPlainName);

/** 同步到 sharedRoot 底下的一個雲端檔案；path 以 / 分隔、相對 sharedRoot */
export type SharedFile = { path: string; fileId: string };

/** 讀不到或損毀的同步紀錄都當成空的，等於重新下載全部檔案 */
async function readSyncState(statePath: string): Promise<Record<string, string>> {
  try {
    const state: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
    return Object.fromEntries(Object.entries(state).filter(([p, id]) => typeof id === 'string' && isPlainPath(p)));
  } catch {
    return {};
  }
}

const PAGE_SIZE = 1000;

async function selectAll<T>(db: Db, table: string, columns: string, projectId: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db.from(table).select(columns).eq('project_id', projectId).order('id').range(from, from + PAGE_SIZE - 1);
    if (error) throw new SyncError(`無法讀取專案檔案清單：${error.message}`);
    rows.push(...(data as T[]));
    if (data.length < PAGE_SIZE) return rows;
  }
}

type FolderRow = { id: string; parent_id: string | null; name: string };
type FileRow = { id: string; folder_id: string; name: string };

/** 雲端資料夾裡的所有檔案，依路徑排序；名稱不合法或與別的路徑衝突的略過 */
async function listSharedFiles(db: Db, projectId: string): Promise<SharedFile[]> {
  const [folders, files] = await Promise.all([
    selectAll<FolderRow>(db, 'project_folders', 'id, parent_id, name', projectId),
    selectAll<FileRow>(db, 'project_files', 'id, folder_id, name', projectId),
  ]);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const folderPath = (id: string): string[] | null => {
    const segs: string[] = [];
    const seen = new Set<string>();
    for (let f = byId.get(id); f && !seen.has(f.id); f = f.parent_id ? byId.get(f.parent_id) : undefined) {
      seen.add(f.id);
      segs.unshift(f.name);
      if (!f.parent_id) return segs;
    }
    return null;
  };

  const listed: SharedFile[] = [];
  for (const file of files) {
    const dirs = folderPath(file.folder_id);
    const segs = dirs ? [...dirs, file.name] : [];
    // 每一段各自檢查（先接起來再拆會放過含 / 的名稱）；根目錄只有資料夾，與同步紀錄檔同名的資料夾會蓋掉紀錄檔
    if (segs.length < 2 || !segs.every(isPlainName) || segs[0] === SHARED_STATE) {
      console.warn(`[sync] 略過名稱不合法的專案檔案 ${file.id}`);
      continue;
    }
    listed.push({ path: segs.join('/'), fileId: file.id });
  }
  // 同一層有同名的檔案與資料夾時，本機只能放一個：保留資料夾，否則每次同步都會互相蓋掉
  const dirPaths = new Set(listed.flatMap((f) => {
    const segs = f.path.split('/');
    return segs.slice(1).map((_, i) => segs.slice(0, i + 1).join('/'));
  }));
  return listed
    .filter((f) => {
      if (!dirPaths.has(f.path)) return true;
      console.warn(`[sync] 略過與資料夾同名的專案檔案 ${f.path}`);
      return false;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 從 root 往下逐層確認都是真的資料夾（lstat：symlink 不算） */
async function isRealDirChain(root: string, dirs: string[]): Promise<boolean> {
  let dir = root;
  for (const name of dirs) {
    dir = path.join(dir, name);
    if (!(await lstat(dir).catch(() => null))?.isDirectory()) return false;
  }
  return true;
}

/** 從 root 往下逐層建立資料夾；agent 換成 symlink 或檔案的就刪掉重建，不跟著 symlink 寫到別處 */
async function ensureRealDirs(root: string, dirs: string[]): Promise<void> {
  let dir = root;
  for (const name of dirs) {
    dir = path.join(dir, name);
    const st = await lstat(dir).catch(() => null);
    if (st?.isDirectory()) continue;
    if (st) await rm(dir, { force: true });
    await mkdir(dir);
  }
}

/**
 * 在 root 底下建立新檔案寫入內容。agent 可能建立了同名檔案（擁有者是 agent，runtime 不能改寫但可以刪），先刪再建；
 * wx（O_CREAT|O_EXCL）在目標被換成 symlink 時直接失敗，不會跟著寫。
 */
async function writeNewFile(root: string, segs: string[], content: Uint8Array | string): Promise<void> {
  const dirs = segs.slice(0, -1);
  const target = path.join(root, ...segs);
  await ensureRealDirs(root, dirs);
  await rm(target, { force: true });
  const fh = await open(target, 'wx');
  try {
    // 上層資料夾若在檢查之後才被換成 symlink，檔案會建到別處：寫入前確認上層仍是真的資料夾，且開到的就是這個位置的檔案
    const opened = await fh.stat({ bigint: true });
    const here = (await isRealDirChain(root, dirs)) ? await lstat(target, { bigint: true }).catch(() => null) : null;
    if (!here || here.ino !== opened.ino || here.dev !== opened.dev) {
      throw new SyncError(`共用資料夾在同步途中被換掉，停止寫入 ${segs.join('/')}`);
    }
    await fh.writeFile(content);
  } finally {
    await fh.close();
  }
}

/** 由下往上刪掉變空的資料夾；遇到非空（顧問自己放的東西）或不是資料夾就停 */
async function removeEmptyDirs(root: string, dirs: string[]): Promise<void> {
  for (let i = dirs.length; i > 0; i--) {
    try {
      await rmdir(path.join(root, ...dirs.slice(0, i)));
    } catch {
      return;
    }
  }
}

/**
 * 把雲端資料夾整棵同步到 sharedRoot（storage 物件在 <專案>/files/<檔案id>）。
 * sharedRoot 所有顧問都能寫：顧問自己放的東西不刪，寫入時不跟著 symlink 走。
 */
export async function syncSharedFiles(db: Db, projectId: string, sharedRoot: string): Promise<SharedFile[]> {
  await mkdir(sharedRoot, { recursive: true });
  const bucket = db.storage.from('project-files');
  const files = await listSharedFiles(db, projectId);
  const wanted = new Set(files.map((f) => f.path));

  const statePath = path.join(sharedRoot, SHARED_STATE);
  const previous = await readSyncState(statePath);

  // 先刪掉不在清單裡的，資料夾與檔案互換名稱時才不會卡住
  for (const p of Object.keys(previous)) {
    if (wanted.has(p)) continue;
    const segs = p.split('/');
    const dirs = segs.slice(0, -1);
    // 上層被換成 symlink 就不碰，免得刪到共用資料夾以外的檔案
    if (!(await isRealDirChain(sharedRoot, dirs))) continue;
    await rm(path.join(sharedRoot, ...segs), { force: true }).catch(() => undefined);
    await removeEmptyDirs(sharedRoot, dirs);
  }

  const next: Record<string, string> = {};
  for (const f of files) {
    const segs = f.path.split('/');
    const unchanged = previous[f.path] === f.fileId
      && (await isRealDirChain(sharedRoot, segs.slice(0, -1)))
      && (await lstat(path.join(sharedRoot, ...segs)).catch(() => null))?.isFile();
    if (!unchanged) {
      const { data: blob, error } = await bucket.download(`${projectId}/files/${f.fileId}`);
      if (error || !blob) throw new SyncError(`無法下載專案檔案 ${f.path}：${error?.message ?? '空檔案'}`);
      await writeNewFile(sharedRoot, segs, new Uint8Array(await blob.arrayBuffer()));
    }
    next[f.path] = f.fileId;
  }
  // agent 可能把紀錄檔換成 symlink；先刪再建，才不會跟著寫到別的檔案
  await writeNewFile(sharedRoot, [SHARED_STATE], JSON.stringify(next));
  return files;
}
