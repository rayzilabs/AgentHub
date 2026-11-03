import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { Db } from './db';
import { errorText, SyncError } from './errors';
import { runInSandbox, type Sandbox } from './sandbox';
import type { AgentInstance } from './types';

const SKILLS_MARKER = '.zip-path';

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

/** 路徑的每一段都只能是單純的名稱，且不超過 Linux 單一名稱的 255 bytes（中文一字 3 bytes，資料庫的 100 字可能超過） */
function isPlainName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(name) && Buffer.byteLength(name) <= 255;
}

/** Linux 整條路徑的上限 */
const PATH_MAX_BYTES = 4095;

/** 同步到 sharedRoot 底下的一個雲端檔案；path 以 / 分隔、相對 sharedRoot */
export type SharedFile = { path: string; fileId: string };

/** 讀不到、不是一般檔案或損毀的同步紀錄都當成空的，等於重新下載全部檔案 */
async function readSyncState(statePath: string): Promise<Record<string, string>> {
  try {
    if (!(await lstat(statePath)).isFile()) return {};
    const state: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
    return Object.fromEntries(Object.entries(state).filter(([p, id]) => typeof id === 'string' && p.split('/').every(isPlainName)));
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
    // 每一段各自檢查（先接起來再拆會放過含 / 的名稱）
    if (segs.length < 2 || !segs.every(isPlainName)) {
      console.warn(`[sync] 略過名稱不合法的專案檔案 ${file.id}`);
      continue;
    }
    listed.push({ path: segs.join('/'), fileId: file.id });
  }
  // 同一層有同名的檔案與資料夾時，本機只能放一個：保留資料夾，否則每次同步都會互相蓋掉
  const dirPaths = new Set(listed.flatMap((f) => ancestors(f.path)));
  return listed
    .filter((f) => {
      if (!dirPaths.has(f.path)) return true;
      console.warn(`[sync] 略過與資料夾同名的專案檔案 ${f.path}`);
      return false;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 'a/b/c.txt' → ['a', 'a/b'] */
function ancestors(p: string): string[] {
  const segs = p.split('/');
  return segs.slice(1).map((_, i) => segs.slice(0, i + 1).join('/'));
}

/** 從 root 往下逐層確認都是真的資料夾（lstat：symlink 不算）；只讀不改 */
async function isRealDirChain(root: string, p: string): Promise<boolean> {
  for (const dir of ancestors(p)) {
    if (!(await lstat(path.join(root, ...dir.split('/'))).catch(() => null))?.isDirectory()) return false;
  }
  return true;
}

// /shared 裡的建立、寫入、刪除一律以沙盒帳號執行（runtime 自己只做 lstat 這類唯讀檢查）：
// 共用資料夾所有顧問都能寫，顧問可以把資料夾換成 symlink；以沙盒帳號執行時，跟著 symlink 走到的地方也只是顧問本來就碰得到的。
// 路徑一律以參數傳入（相對 sharedRoot、已檢查過每一段），不接進腳本；檔案內容從 stdin 傳入。

// $1 是檔案（一定在某個資料夾裡），其後是由上往下的每一層資料夾：被換成 symlink 或不是資料夾就刪掉重建。
// 內容先寫進同一層新建的暫存檔再改名蓋過去：mktemp 一定建立新檔，不會開到顧問換上的 FIFO 而卡住；
// 改名是原子的，顧問不會讀到寫一半的檔案，原本的是唯讀檔或 symlink 也一併換掉。
// 被砍掉時可能留下 .agenthub-sync.* 暫存檔，它不在同步紀錄裡，之後的同步不會碰它。
const WRITE_SCRIPT = [
  'f=$1; shift',
  'for d in "$@"; do',
  '  if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then rm -f -- "$d" || exit 1; fi',
  '  [ -d "$d" ] || mkdir -- "$d" || exit 1',
  'done',
  't=$(mktemp -- "${f%/*}/.agenthub-sync.XXXXXXXXXX") || exit 1',
  'trap \'rm -f -- "$t"; exit 1\' TERM',
  // mktemp 建立的是 600；改成跟直接建立檔案一樣（沙盒的 umask 002 → 664），其他顧問才讀得到
  'chmod -- "$(printf %o $((0666 & ~$(umask))))" "$t" && cat > "$t" && mv -fT -- "$t" "$f" || { rm -f -- "$t"; exit 1; }',
].join('\n');

// $1 是檔案，其後是由下往上的每一層資料夾：變空的就刪，遇到非空（顧問自己放的東西）就停。
// 原位置變成真的資料夾（顧問自己放的）就不刪，當成已處理；其他刪不掉的情況回報失敗，下次再試
const DELETE_SCRIPT = [
  'if ! rm -f -- "$1"; then [ -d "$1" ] && [ ! -L "$1" ] || exit 1; fi',
  'shift',
  'for d in "$@"; do rmdir -- "$d" 2>/dev/null || exit 0; done',
].join('\n');

/** 單一指令的時間上限（秒）：顧問能讓寫入卡住（例如換上 FIFO），不能讓整個 run 停在準備階段 */
const SHARED_TIMEOUT_SECONDS = 120;

async function inShared(sandbox: Sandbox, sharedRoot: string, script: string, args: string[], input?: Uint8Array): Promise<void> {
  // timeout 在沙盒帳號裡執行，砍得掉自己的子行程；-k：送 TERM 後 5 秒還沒結束就 KILL
  const argv = ['timeout', '-k', '5', String(SHARED_TIMEOUT_SECONDS), 'bash', '-c', script, 'sync', ...args];
  const r = await runInSandbox(sandbox, argv, { cwd: sharedRoot, input });
  if (r.code === 124 || r.code === 137) throw new Error(`超過 ${SHARED_TIMEOUT_SECONDS} 秒`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `結束碼 ${r.code}`);
}

export type SharedSyncIo = {
  /** 寫入與刪除用的沙盒帳號（Sprite 上是 config.SANDBOX_USER） */
  sandbox: Sandbox;
  /** 同步紀錄 { [path]: fileId }，放在顧問改不到的地方（config.SYNC_STATE_PATH） */
  statePath: string;
};

/**
 * 把雲端資料夾整棵同步到 sharedRoot（storage 物件在 <專案>/files/<檔案id>），回傳同步好的檔案。
 * 讀不到清單才算同步失敗；單一檔案下載或寫入失敗只略過那一個，不讓整個 run 失敗。
 */
export async function syncSharedFiles(db: Db, projectId: string, sharedRoot: string, io: SharedSyncIo): Promise<SharedFile[]> {
  await mkdir(sharedRoot, { recursive: true });
  const bucket = db.storage.from('project-files');
  const files = await listSharedFiles(db, projectId);
  const wanted = new Set(files.map((f) => f.path));
  const previous = await readSyncState(io.statePath);

  // 沒處理好的路徑留在紀錄裡，下次再試：刪不掉的保留原本的 fileId；寫不進去的記成 ''
  // （'' 不會等於任何 fileId，下次一定重寫；之後雲端刪掉它，本機留著的舊副本也會被清掉）
  const next: Record<string, string> = {};
  const synced: SharedFile[] = [];

  // 先刪掉不在清單裡的，資料夾與檔案互換名稱時才不會卡住
  for (const p of Object.keys(previous)) {
    if (wanted.has(p)) continue;
    // 上層被換成 symlink 就不碰
    if (!(await isRealDirChain(sharedRoot, p))) continue;
    await inShared(io.sandbox, sharedRoot, DELETE_SCRIPT, [p, ...ancestors(p).reverse()]).catch((e) => {
      next[p] = previous[p];
      console.warn(`[sync] 無法刪除 ${p}：${errorText(e)}`);
    });
  }

  for (const f of files) {
    try {
      const local = path.join(sharedRoot, ...f.path.split('/'));
      if (Buffer.byteLength(local) > PATH_MAX_BYTES) throw new SyncError('路徑太長');
      const unchanged = previous[f.path] === f.fileId
        && (await isRealDirChain(sharedRoot, f.path))
        && (await lstat(local).catch(() => null))?.isFile();
      if (!unchanged) {
        const { data: blob, error } = await bucket.download(`${projectId}/files/${f.fileId}`);
        if (error || !blob) throw new SyncError(`無法下載：${error?.message ?? '空檔案'}`);
        await inShared(io.sandbox, sharedRoot, WRITE_SCRIPT, [f.path, ...ancestors(f.path)], new Uint8Array(await blob.arrayBuffer()));
      }
      next[f.path] = f.fileId;
      synced.push(f);
    } catch (e) {
      next[f.path] = '';
      console.warn(`[sync] 略過專案檔案 ${f.path}：${errorText(e)}`);
    }
  }
  await mkdir(path.dirname(io.statePath), { recursive: true, mode: 0o700 });
  await writeFile(io.statePath, JSON.stringify(next));
  return synced;
}
