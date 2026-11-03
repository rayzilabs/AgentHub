import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '@/lib/http';
import type { Db } from '@/lib/supabase/admin';
import { getOwnProject } from './projects';

export const UPLOAD_FOLDER = '我上傳的';
const BUCKET = 'project-files';
const NAME_CONFLICT = '這個資料夾已經有同名檔案';

export type FolderRow = { id: string; parent_id: string | null; name: string };
export type FileRow = {
  id: string;
  folder_id: string;
  name: string;
  size: number;
  content_type: string;
  source: 'user' | 'agent';
  agent_instance_id: string | null;
  created_at: string;
  updated_at: string;
};
export type ProjectTree = { folders: FolderRow[]; files: FileRow[] };

export const entryName = z
  .string()
  .min(1, '名稱不能有 / 或 \\，長度 1～100 字')
  .max(100, '名稱不能有 / 或 \\，長度 1～100 字')
  .refine((s) => !/[/\\\u0000-\u001f\u007f]/.test(s) && s !== '.' && s !== '..', '名稱不能有 / 或 \\，長度 1～100 字');

export const storagePath = (projectId: string, fileId: string) => `${projectId}/files/${fileId}`;

const FILE_COLUMNS = 'id, folder_id, name, size, content_type, source, agent_instance_id, created_at, updated_at';
const FOLDER_COLUMNS = 'id, parent_id, name';

const isUniqueViolation = (e: { code?: string } | null) => e?.code === '23505';

async function loadFolders(db: Db, projectId: string): Promise<FolderRow[]> {
  const { data, error } = await db.from('project_folders').select(FOLDER_COLUMNS).eq('project_id', projectId).order('name');
  if (error) throw error;
  return data as FolderRow[];
}

async function requireFolder(db: Db, projectId: string, folderId: string): Promise<FolderRow> {
  const { data, error } = await db.from('project_folders').select(FOLDER_COLUMNS).eq('id', folderId).eq('project_id', projectId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, '找不到這個資料夾');
  return data as FolderRow;
}

async function requireFile(db: Db, projectId: string, fileId: string): Promise<FileRow> {
  const { data, error } = await db.from('project_files').select(FILE_COLUMNS).eq('id', fileId).eq('project_id', projectId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, '找不到這個檔案');
  return data as FileRow;
}

async function removeObjects(db: Db, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 1000) {
    const { error } = await db.storage.from(BUCKET).remove(paths.slice(i, i + 1000));
    if (error) throw error;
  }
}

export async function getProjectTree(db: Db, userId: string, projectId: string): Promise<ProjectTree> {
  await getOwnProject(db, userId, projectId);
  const [folders, filesResult] = await Promise.all([
    loadFolders(db, projectId),
    db.from('project_files').select(FILE_COLUMNS).eq('project_id', projectId).order('name'),
  ]);
  if (filesResult.error) throw filesResult.error;
  return { folders, files: filesResult.data as FileRow[] };
}

export async function createUploadUrl(db: Db, userId: string, projectId: string): Promise<{ fileId: string; signedUrl: string }> {
  await getOwnProject(db, userId, projectId);
  const fileId = randomUUID();
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(storagePath(projectId, fileId));
  if (error) throw error;
  return { fileId, signedUrl: data.signedUrl };
}

export async function completeUpload(
  db: Db,
  userId: string,
  projectId: string,
  input: { fileId: string; folderId: string | null; name: string },
): Promise<FileRow> {
  await getOwnProject(db, userId, projectId);
  let folderId = input.folderId;
  if (folderId) {
    await requireFolder(db, projectId, folderId);
  } else {
    const { data, error } = await db.rpc('ensure_folder', { p_project_id: projectId, p_parent_id: null, p_name: UPLOAD_FOLDER });
    if (error) throw error;
    folderId = data as string;
  }
  const { data, error } = await db.rpc('register_project_file', {
    p_project_id: projectId,
    p_file_id: input.fileId,
    p_folder_id: folderId,
    p_name: input.name,
    p_source: 'user',
    p_instance_id: null,
    p_run_id: null,
  });
  if (error) {
    if (error.message.includes('storage object missing')) throw new HttpError(400, '檔案尚未上傳完成');
    if (error.message.includes('folder not found')) throw new HttpError(404, '找不到這個資料夾');
    throw error;
  }
  return data as FileRow;
}

export async function updateFile(
  db: Db,
  userId: string,
  projectId: string,
  fileId: string,
  input: { name?: string; folderId?: string },
): Promise<FileRow> {
  await getOwnProject(db, userId, projectId);
  await requireFile(db, projectId, fileId);
  const patch: Record<string, string> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.folderId !== undefined) {
    await requireFolder(db, projectId, input.folderId);
    patch.folder_id = input.folderId;
  }
  const { data, error } = await db.from('project_files').update(patch).eq('id', fileId).eq('project_id', projectId).select(FILE_COLUMNS).single();
  if (isUniqueViolation(error)) throw new HttpError(409, NAME_CONFLICT);
  if (error) throw error;
  return data as FileRow;
}

export async function deleteFile(db: Db, userId: string, projectId: string, fileId: string): Promise<void> {
  await getOwnProject(db, userId, projectId);
  await requireFile(db, projectId, fileId);
  // 先刪物件再刪資料列：反過來的話 runtime 可能把殘留的物件重新登記回來
  await removeObjects(db, [storagePath(projectId, fileId)]);
  const { error } = await db.from('project_files').delete().eq('id', fileId).eq('project_id', projectId);
  if (error) throw error;
}

export async function createFolder(db: Db, userId: string, projectId: string, input: { name: string; parentId: string | null }): Promise<FolderRow> {
  await getOwnProject(db, userId, projectId);
  if (input.parentId) await requireFolder(db, projectId, input.parentId);
  const { data, error } = await db
    .from('project_folders')
    .insert({ project_id: projectId, parent_id: input.parentId, name: input.name })
    .select(FOLDER_COLUMNS)
    .single();
  if (isUniqueViolation(error)) throw new HttpError(409, '這裡已經有同名資料夾');
  if (error) throw error;
  return data as FolderRow;
}

export async function updateFolder(
  db: Db,
  userId: string,
  projectId: string,
  folderId: string,
  input: { name?: string; parentId?: string | null },
): Promise<FolderRow> {
  await getOwnProject(db, userId, projectId);
  const folders = await loadFolders(db, projectId);
  if (!folders.some((f) => f.id === folderId)) throw new HttpError(404, '找不到這個資料夾');
  const patch: Record<string, string | null> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.parentId !== undefined) {
    if (input.parentId !== null) {
      const byId = new Map(folders.map((f) => [f.id, f]));
      if (!byId.has(input.parentId)) throw new HttpError(404, '找不到這個資料夾');
      // 從新的上層一路往上走，碰到自己就代表搬進了自己或子孫底下
      for (let cur: string | null = input.parentId; cur; cur = byId.get(cur)?.parent_id ?? null) {
        if (cur === folderId) throw new HttpError(400, '不能把資料夾搬進自己裡面');
      }
    }
    patch.parent_id = input.parentId;
  }
  const { data, error } = await db.from('project_folders').update(patch).eq('id', folderId).eq('project_id', projectId).select(FOLDER_COLUMNS).single();
  if (isUniqueViolation(error)) throw new HttpError(409, '這裡已經有同名資料夾');
  if (error) throw error;
  return data as FolderRow;
}

// PostgREST 每次最多回 1000 筆，所以要分頁；資料夾 id 也分批，避免 URL 過長
export async function collectFileIds(db: Db, projectId: string, folderIds: string[], pageSize = 1000, chunkSize = 100): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < folderIds.length; i += chunkSize) {
    const chunk = folderIds.slice(i, i + chunkSize);
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await db
        .from('project_files')
        .select('id')
        .eq('project_id', projectId)
        .in('folder_id', chunk)
        .order('id')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      out.push(...(data as { id: string }[]).map((f) => f.id));
      if (data.length < pageSize) break;
    }
  }
  return out;
}

export async function deleteFolder(db: Db, userId: string, projectId: string, folderId: string): Promise<void> {
  await getOwnProject(db, userId, projectId);
  const folders = await loadFolders(db, projectId);
  if (!folders.some((f) => f.id === folderId)) throw new HttpError(404, '找不到這個資料夾');
  const ids = new Set([folderId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) {
      if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  // 先刪物件再刪資料列（理由同 deleteFile）
  await removeObjects(db, (await collectFileIds(db, projectId, [...ids])).map((id) => storagePath(projectId, id)));
  const { error: delError } = await db.from('project_folders').delete().eq('id', folderId).eq('project_id', projectId);
  if (delError) throw delError;
}

export async function fileDownloadUrl(db: Db, userId: string, fileId: string): Promise<{ url: string; name: string }> {
  const gone = () => new HttpError(404, '檔案已刪除');
  const { data: file, error } = await db.from('project_files').select('project_id, name').eq('id', fileId).maybeSingle();
  if (error) throw error;
  if (!file) throw gone();
  await getOwnProject(db, userId, file.project_id).catch(() => {
    throw gone();
  });
  const { data, error: urlError } = await db.storage.from(BUCKET).createSignedUrl(storagePath(file.project_id, fileId), 60, { download: file.name });
  if (urlError) throw urlError;
  return { url: data.signedUrl, name: file.name };
}

async function listAllFiles(db: Db, prefix: string): Promise<string[]> {
  const paths: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.storage.from(BUCKET).list(prefix, { limit: 1000, offset });
    if (error) throw error;
    // id 為 null 的是子資料夾，不是物件
    paths.push(...data.filter((o) => o.id !== null).map((o) => `${prefix}/${o.name}`));
    if (data.length < 1000) return paths;
  }
}

export async function removeProjectStorage(db: Db, projectId: string): Promise<void> {
  const paths = [...(await listAllFiles(db, `${projectId}/files`)), ...(await listAllFiles(db, projectId))];
  await removeObjects(db, paths);
}
