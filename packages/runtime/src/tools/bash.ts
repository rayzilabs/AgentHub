import { spawn } from 'node:child_process';
import { tool } from 'ai';
import { z } from 'zod';

export const BASH_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT = 20_000;

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[已截斷，原長度 ${text.length} 字元]`;
}

export function runBash(
  command: string,
  cwd: string,
  timeoutMs = BASH_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, env: process.env, signal: abortSignal });
    let output = '';
    let total = 0;
    const append = (chunk: Buffer) => {
      total += chunk.length;
      if (output.length < MAX_OUTPUT * 2) output += chunk.toString();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const done = (exitCode: number | null, extra = '') => {
      clearTimeout(timer);
      const text = total > output.length ? output + '…'.repeat(MAX_OUTPUT) : output;
      resolve({ exitCode, output: truncate(text + extra), timedOut });
    };
    child.on('close', (code) => done(code));
    child.on('error', (err) => done(null, `\n${err.message}`));
  });
}

export function bashTool(cwd: string) {
  return tool({
    description: '在你的工作目錄執行 bash 指令。單次最長 120 秒，輸出超過 20000 字元會被截斷。',
    inputSchema: z.object({ command: z.string().describe('要執行的 bash 指令') }),
    execute: async ({ command }, { abortSignal }) => runBash(command, cwd, BASH_TIMEOUT_MS, abortSignal),
  });
}
