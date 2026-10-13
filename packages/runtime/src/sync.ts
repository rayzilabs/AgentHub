import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

/** 只接受單純的檔名：同步紀錄放在 agent 可寫的資料夾，內容不可信，不能讓它指到資料夾以外 */
function isPlainName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\]/.test(name);
}

/** 讀不到或損毀的同步紀錄都當成空的，等於重新下載全部檔案 */
async function readSyncState(statePath: string): Promise<Record<string, string>> {
  try {
    const state: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
    return Object.fromEntries(Object.entries(state as Record<string, string>).filter(([name]) => isPlainName(name)));
  } catch {
    return {};
  }
}

export async function syncSharedFiles(db: Db, projectId: string, sharedRoot: string): Promise<string[]> {
  await mkdir(sharedRoot, { recursive: true });
  const bucket = db.storage.from('project-files');
  const { data, error } = await bucket.list(projectId, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw new SyncError(`無法列出專案檔案：${error.message}`);
  const objects = data.filter((o) => o.id !== null);

  const statePath = path.join(sharedRoot, SHARED_STATE);
  const previous = await readSyncState(statePath);
  const next: Record<string, string> = {};

  for (const o of objects) {
    const stamp = o.updated_at ?? '';
    if (previous[o.name] !== stamp) {
      const { data: blob, error: downloadError } = await bucket.download(`${projectId}/${o.name}`);
      if (downloadError || !blob) throw new SyncError(`無法下載專案檔案 ${o.name}：${downloadError?.message ?? '空檔案'}`);
      const target = path.join(sharedRoot, o.name);
      // agent 可能建立了同名檔案（擁有者是 agent，runtime 不能改寫但可以刪），先刪再寫
      await rm(target, { force: true });
      await writeFile(target, Buffer.from(await blob.arrayBuffer()));
    }
    next[o.name] = stamp;
  }
  for (const name of Object.keys(previous)) {
    if (!(name in next)) await rm(path.join(sharedRoot, name), { force: true });
  }
  // agent 可能把紀錄檔換成 symlink；先刪再寫，才不會跟著寫到別的檔案
  await rm(statePath, { force: true });
  await writeFile(statePath, JSON.stringify(next));
  return objects.map((o) => o.name);
}
