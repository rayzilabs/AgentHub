import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Db = SupabaseClient;

/** 專案雲端資料夾的檔案（web 端 services/files.ts 的 storagePath 是同一個規則） */
export const PROJECT_FILES_BUCKET = 'project-files';
export const projectFilePath = (projectId: string, fileId: string) => `${projectId}/files/${fileId}`;

/** runtime 帳號的通行證只用在這次 run；publishable key 是公開的，權限全看通行證 */
export function createUserDb(url: string, publishableKey: string, token: string): Db {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
