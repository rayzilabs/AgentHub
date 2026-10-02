import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { errorText } from '../errors';
import { truncate } from './bash';

export function readFileTool(cwd: string) {
  return tool({
    description: '讀取檔案。相對路徑以你的工作目錄為基準，也可以用絕對路徑讀專案共用檔案。超過 20000 字元會被截斷。',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path: p }) => {
      try {
        return { content: truncate(await readFile(path.resolve(cwd, p), 'utf8')) };
      } catch (e) {
        return { error: errorText(e) };
      }
    },
  });
}

export function writeFileTool(cwd: string) {
  return tool({
    description: '寫入檔案（覆蓋），需要的資料夾會自動建立。相對路徑以你的工作目錄為基準。',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path: p, content }) => {
      try {
        const target = path.resolve(cwd, p);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
        return { ok: true, path: target };
      } catch (e) {
        return { error: errorText(e) };
      }
    },
  });
}
