import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

export function skillsDir(agentsRoot: string, instanceId: string): string {
  return path.join(agentsRoot, instanceId, 'skills');
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

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, content] of entries) {
    const target = path.resolve(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(path.join(dir, SKILLS_MARKER), instance.skills_zip_path);
}

/** 讀不到或損毀的同步紀錄都當成空的，等於重新下載全部檔案 */
async function readSyncState(statePath: string): Promise<Record<string, string>> {
  try {
    const state: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? (state as Record<string, string>) : {};
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
      await writeFile(path.join(sharedRoot, o.name), Buffer.from(await blob.arrayBuffer()));
    }
    next[o.name] = stamp;
  }
  for (const name of Object.keys(previous)) {
    if (!(name in next)) await rm(path.join(sharedRoot, name), { force: true });
  }
  await writeFile(statePath, JSON.stringify(next));
  return objects.map((o) => o.name);
}
