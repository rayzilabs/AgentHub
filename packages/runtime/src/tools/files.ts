import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { runInSandbox, type Sandbox } from '../sandbox';
import { DESCRIPTION_FIELD, MAX_OUTPUT, truncate } from './bash';

/** 多讀一些位元組再截斷，確保 20000 字元內不會切到多位元組字 */
const READ_LIMIT_BYTES = MAX_OUTPUT * 4;

/** 以沙盒帳號讀寫：權限與 bash 相同，讀不到的檔案（含 symlink 指向的）一樣讀不到 */
export function readFileTool(cwd: string, sandbox: Sandbox) {
  return tool({
    description: '讀取檔案。相對路徑以你的工作目錄為基準，也可以用絕對路徑讀專案共用檔案。超過 20000 字元會被截斷。',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path: p }) => {
      const target = path.resolve(cwd, p);
      const r = await runInSandbox(sandbox, ['bash', '-c', 'head -c "$1" -- "$2"', 'read_file', String(READ_LIMIT_BYTES), target], { cwd });
      if (r.code !== 0) return { error: r.stderr.trim() || `無法讀取 ${target}` };
      return { content: truncate(r.stdout) };
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
