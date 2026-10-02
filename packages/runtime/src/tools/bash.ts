import { spawn } from 'node:child_process';
import { tool } from 'ai';
import { z } from 'zod';

export const BASH_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT = 20_000;
const KILL_GRACE_MS = 200;

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
    // detached：讓 bash 成為獨立行程群組，逾時或中止時能連同子行程一起終止
    const child = spawn('bash', ['-c', command], { cwd, env: process.env, detached: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let output = '';
    let overflowed = false;
    const append = (chunk: string) => {
      if (overflowed) return;
      output += chunk;
      if (output.length >= MAX_OUTPUT * 2) {
        output = output.slice(0, MAX_OUTPUT * 2);
        overflowed = true;
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    let settled = false;
    const done = (exitCode: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      // overflowed 時 output 已達 MAX_OUTPUT * 2，必定超過上限而被 truncate 標記
      resolve({ exitCode, output: truncate(output + extra), timedOut });
    };
    // 脫離行程群組的孫行程（setsid、setpgrp）可能一直佔住 stdout，'close' 永遠等不到；
    // 被終止後只等 bash 本身結束，再給一點時間收完輸出就關掉 pipe
    const hasExited = () => child.exitCode !== null || child.signalCode !== null;
    const forceDone = () => setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      done(child.exitCode);
    }, KILL_GRACE_MS);
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      killGroup();
      if (hasExited()) forceDone();
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });
    child.on('exit', () => {
      if (killed) forceDone();
    });
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
