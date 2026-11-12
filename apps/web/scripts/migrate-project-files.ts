// 用法：cd apps/web && pnpm exec tsx scripts/migrate-project-files.ts
// 把舊制放在 project-files/<專案>/<檔名> 的檔案搬到 <專案>/files/<檔案id>，登記進「我上傳的」。
// 可重複執行：搬過的物件已不在第一層。
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UPLOAD_FOLDER_NAME } from '@/lib/file-tree';
import { storagePath } from '@/lib/services/files';
import type { Db } from '@/lib/supabase/admin';

const BUCKET = 'project-files';
const MAX_NAME = 100;

// 舊制檔名沒有長度上限，新制最多 100 字：保留副檔名，截短主檔名
function entryNameFrom(name: string): string {
  const chars = [...name];
  if (chars.length <= MAX_NAME) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? [...name.slice(dot)] : [];
  if (ext.length >= MAX_NAME) return chars.slice(0, MAX_NAME).join('');
  return [...chars.slice(0, chars.length - ext.length).slice(0, MAX_NAME - ext.length), ...ext].join('');
}

async function legacyObjects(db: Db, projectId: string): Promise<string[]> {
  const names: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.storage.from(BUCKET).list(projectId, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    // id 為 null 的是子資料夾（含新制的 files/）
    names.push(...data.filter((o) => o.id !== null && o.name !== '.emptyFolderPlaceholder').map((o) => o.name));
    if (data.length < 1000) return names;
  }
}

export async function migrateProjectFiles(db: Db, projectId: string): Promise<{ moved: number }> {
  const names = await legacyObjects(db, projectId);
  if (names.length === 0) return { moved: 0 };
  const { data: folderId, error: folderError } = await db.rpc('ensure_folder', { p_project_id: projectId, p_parent_id: null, p_name: UPLOAD_FOLDER_NAME });
  if (folderError) throw folderError;
  let moved = 0;
  for (const name of names) {
    const fileId = randomUUID();
    const from = `${projectId}/${name}`;
    const to = storagePath(projectId, fileId);
    const { error: moveError } = await db.storage.from(BUCKET).move(from, to);
    if (moveError) throw moveError;
    const { error } = await db.rpc('register_project_file', {
      p_project_id: projectId,
      p_file_id: fileId,
      p_folder_id: folderId,
      p_name: entryNameFrom(name),
      p_source: 'user',
      p_instance_id: null,
      p_run_id: null,
    });
    if (error) {
      // 登記失敗就搬回原位，下次重跑還找得到，不會變成沒有紀錄的物件
      const { error: backError } = await db.storage.from(BUCKET).move(to, from);
      if (backError) console.error(`搬回原位失敗（已搬 ${from} → ${to}），請手動把 ${to} 搬回 ${from}：${backError.message}`);
      throw error;
    }
    moved++;
  }
  return { moved };
}

async function main(): Promise<void> {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  const { adminDb } = await import('@/lib/supabase/admin');
  const db = adminDb();
  const failed: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('projects').select('id').order('id').range(from, from + 999);
    if (error) throw error;
    for (const p of data) {
      try {
        const { moved } = await migrateProjectFiles(db, p.id);
        console.log(`${p.id}：搬了 ${moved} 個`);
      } catch (e) {
        failed.push(p.id);
        console.error(`搬移失敗 ${p.id}：`, e instanceof Error ? e.message : e);
      }
    }
    if (data.length < 1000) break;
  }
  if (failed.length > 0) {
    console.error(`${failed.length} 個專案搬移失敗：${failed.join(', ')}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
