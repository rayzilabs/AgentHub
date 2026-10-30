import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { detectImage, type ImageRegistry } from '../images';
import { runInSandbox, type Sandbox } from '../sandbox';
import { DESCRIPTION_FIELD, MAX_OUTPUT, truncate } from './bash';

/** 多讀一些位元組再截斷，確保 20000 字元內不會切到多位元組字 */
const READ_LIMIT_BYTES = MAX_OUTPUT * 4;

const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const sh = (sandbox: Sandbox, cwd: string, script: string, target: string) =>
  runInSandbox(sandbox, ['bash', '-c', script, 'read_file', target], { cwd });

/** 只有共用資料夾第一層的檔案才有 Storage 版本可比對（同步就是這樣放的） */
function sharedName(images: ImageRegistry, target: string): string | null {
  const rel = path.relative(images.sharedRoot, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep) ? rel : null;
}

/**
 * 是圖片就回 { content }（可看或無法檢視的說明），不是圖片回 null 交給一般讀檔。
 * 位元組經沙盒以 base64 取出（權限與 bash 相同）；可看的圖片交給 images 保管，由 toModelOutput 給模型。
 */
async function readImage(sandbox: Sandbox, cwd: string, target: string, images: ImageRegistry | undefined, toolCallId: string): Promise<{ content: string } | null> {
  const head = await sh(sandbox, cwd, 'head -c 16 -- "$1" | base64 -w0', target);
  const mediaType = head.code === 0 ? detectImage(Buffer.from(head.stdout, 'base64')) : null;
  if (!mediaType) return null;
  const name = path.basename(target);
  const unviewable = { content: `這張圖不在共用資料夾（或與上傳的版本不同），無法檢視：${name}` };
  const sharedFile = images && sharedName(images, target);
  if (!images || !sharedFile) return unviewable;
  const size = Number((await sh(sandbox, cwd, 'stat -c %s -- "$1"', target)).stdout.trim());
  if (!(size > 0 && size <= IMAGE_MAX_BYTES)) return unviewable;
  const full = await sh(sandbox, cwd, 'base64 -w0 -- "$1"', target);
  if (full.code !== 0) return unviewable;
  const bytes = new Uint8Array(Buffer.from(full.stdout, 'base64'));
  if (!(await images.resolve(sharedFile, bytes))) return unviewable;
  images.keep(toolCallId, { mediaType, bytes });
  return { content: `圖片：${name}（${mediaType}，${bytes.length} bytes）` };
}

/** 以沙盒帳號讀寫：權限與 bash 相同，讀不到的檔案（含 symlink 指向的）一樣讀不到 */
export function readFileTool(cwd: string, sandbox: Sandbox, images?: ImageRegistry) {
  return tool({
    description: '讀取檔案。相對路徑以你的工作目錄為基準，也可以用絕對路徑讀專案共用檔案。超過 20000 字元會被截斷。專案共用資料夾裡的圖片（png、jpg、webp、gif）會直接給你看。',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path: p }, { toolCallId }): Promise<{ content: string } | { error: string }> => {
      const target = path.resolve(cwd, p);
      const image = await readImage(sandbox, cwd, target, images, toolCallId);
      if (image) return image;
      const r = await runInSandbox(sandbox, ['bash', '-c', 'head -c "$1" -- "$2"', 'read_file', String(READ_LIMIT_BYTES), target], { cwd });
      if (r.code !== 0) return { error: r.stderr.trim() || `無法讀取 ${target}` };
      return { content: truncate(r.stdout) };
    },
    // 存進資料庫的是 execute 的輸出（只有文字）；圖片只在這裡交給模型
    toModelOutput: ({ toolCallId, output }) => {
      const image = images?.imageFor(toolCallId);
      if (!image || !('content' in output)) return { type: 'json', value: output };
      return {
        type: 'content',
        value: [
          { type: 'text', text: output.content },
          { type: 'file', mediaType: image.mediaType, data: { type: 'data', data: image.bytes } },
        ],
      };
    },
  });
}

export function writeFileTool(cwd: string, sandbox: Sandbox) {
  return tool({
    description: '寫入檔案（覆蓋），需要的資料夾會自動建立。相對路徑以你的工作目錄為基準。',
    inputSchema: z.object({ path: z.string(), content: z.string(), description: DESCRIPTION_FIELD }),
    execute: async ({ path: p, content }) => {
      const target = path.resolve(cwd, p);
      // 內容從 stdin 傳入，不放進指令參數
      const r = await runInSandbox(
        sandbox,
        ['bash', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'write_file', target],
        { cwd, input: content },
      );
      if (r.code !== 0) return { error: r.stderr.trim() || `無法寫入 ${target}` };
      return { ok: true, path: target };
    },
  });
}
