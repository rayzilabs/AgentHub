import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { Db } from '../db';
import { errorText } from '../errors';
import { runInSandbox, type Sandbox } from '../sandbox';
import type { DeliveredFile } from '../ui-stream';
import { DESCRIPTION_FIELD } from './bash';

export const FILE_LIMIT_BYTES = 50 * 1024 * 1024;
export const RUN_DELIVERY_LIMIT_BYTES = 200 * 1024 * 1024;

/** 一個 run 一份，run 裡所有顧問共用；交付成功才累計 */
export type DeliveryBudget = { used: number };

const CONTENT_TYPES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  html: 'text/html',
  zip: 'application/zip',
};

export function contentTypeOf(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** deliver_project_file 丟出的錯誤轉成給模型看的說明 */
function friendlyError(message: string): string {
  if (message.includes('invalid name')) return '檔名不合法：不可為空、超過 100 字、含 / \\ 或控制字元，也不可是 . 或 ..';
  if (message.includes('invalid folder')) return '資料夾名稱不合法：每一層都要是合法名稱，用 / 分層，不可有空的層級';
  if (message.includes('storage object missing')) return '檔案上傳後找不到，請再試一次';
  if (message.includes('not allowed')) return '沒有權限交付這個檔案';
  return `交付失敗：${message}`;
}

const sh = (sandbox: Sandbox, cwd: string, script: string, target: string) =>
  runInSandbox(sandbox, ['bash', '-c', script, 'deliver_file', target], { cwd });

export function deliverFileTool(opts: {
  cwd: string;
  sandbox: Sandbox;
  db: Db;
  projectId: string;
  instanceId: string;
  runId: string;
  budget: DeliveryBudget;
  /** 測試用：換成小上限，不必寫 50 MB 的檔案 */
  limits?: { file: number; run: number };
}) {
  const limits = opts.limits ?? { file: FILE_LIMIT_BYTES, run: RUN_DELIVERY_LIMIT_BYTES };
  return tool({
    description: '把做好的檔案交付給使用者：檔案會出現在使用者的雲端資料夾（你的資料夾底下）與這則回覆的下載按鈕，所有顧問也讀得到。只交付成品（報告、圖表、表格），不要交付暫存檔或腳本。',
    inputSchema: z.object({
      path: z.string(),
      folder: z.string().optional().describe('子資料夾，例如 2026-W43，可用 / 分層'),
      name: z.string().optional().describe('給使用者看的檔名，預設用原檔名'),
      description: DESCRIPTION_FIELD,
    }),
    execute: async ({ path: p, folder, name }): Promise<DeliveredFile | { error: string }> => {
      const target = path.resolve(opts.cwd, p);
      // 以沙盒帳號讀取：權限與 bash 相同，讀不到的檔案交付不出去
      if ((await sh(opts.sandbox, opts.cwd, 'test -f "$1"', target)).code !== 0) {
        return { error: `找不到檔案或不是一般檔案：${p}` };
      }
      const size = Number((await sh(opts.sandbox, opts.cwd, 'stat -c %s -- "$1"', target)).stdout.trim());
      if (!Number.isFinite(size)) return { error: `無法讀取檔案大小：${p}` };
      if (size > limits.file) return { error: '檔案超過 50 MB，無法交付' };
      if (opts.budget.used + size > limits.run) return { error: '這次回覆交付的檔案合計超過 200 MB' };
      const read = await sh(opts.sandbox, opts.cwd, 'base64 -w0 -- "$1"', target);
      if (read.code !== 0) return { error: read.stderr.trim() || `無法讀取 ${p}` };
      const bytes = new Uint8Array(Buffer.from(read.stdout, 'base64'));

      const displayName = name?.trim() || path.basename(target);
      const fileId = randomUUID();
      try {
        const up = await opts.db.storage.from('project-files').upload(`${opts.projectId}/files/${fileId}`, bytes, {
          contentType: contentTypeOf(displayName), upsert: false,
        });
        if (up.error) return { error: `上傳失敗：${up.error.message}` };
        // 登記失敗時不刪剛上傳的物件：runtime 沒有刪除權限
        const { data, error } = await opts.db.rpc('deliver_project_file', {
          p_file_id: fileId, p_instance_id: opts.instanceId,
          p_subfolder: (folder ?? '').replace(/^\/+|\/+$/g, ''), p_name: displayName, p_run_id: opts.runId,
        });
        if (error) return { error: friendlyError(error.message) };
        const row = (data as { id: string; name: string; folder: string; size: number | string }[])[0];
        opts.budget.used += bytes.length;
        return { file_id: row.id, name: row.name, folder: row.folder, size: Number(row.size) };
      } catch (e) {
        return { error: `交付失敗：${errorText(e)}` };
      }
    },
  });
}
