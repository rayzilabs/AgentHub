import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT, runBash, truncate } from '../src/tools/bash';
import { readFileTool, writeFileTool } from '../src/tools/files';
import { tmpRoots } from './helpers';

// 工具執行選項：測試只用得到這兩個欄位
const opts = { toolCallId: 't', messages: [] } as never;

async function workDir() {
  const { agentsRoot } = await tmpRoots();
  const dir = path.join(agentsRoot, 'a1');
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('runBash', () => {
  it('在指定目錄執行', async () => {
    const cwd = await workDir();
    await runBash('echo hi > out.txt', cwd);
    expect(await readFile(path.join(cwd, 'out.txt'), 'utf8')).toBe('hi\n');
  });

  it('非 0 結束碼回傳而不丟例外，並包含 stderr', async () => {
    const r = await runBash('echo boom >&2; exit 3', await workDir());
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('boom');
  });

  it('逾時會中止', async () => {
    const r = await runBash('sleep 5', await workDir(), 200);
    expect(r.timedOut).toBe(true);
  });

  it('多位元組輸出不會被誤判為過長', async () => {
    const r = await runBash('echo 你好', await workDir());
    expect(r.output).toBe('你好\n');
    expect(r.output).not.toContain('已截斷');
  });

  it('逾時會連子行程一起終止', async () => {
    const start = Date.now();
    const r = await runBash('sleep 5; echo x', await workDir(), 200);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('逾時時，脫離行程群組的孫行程佔住 stdout 也不會卡住', async () => {
    const start = Date.now();
    const r = await runBash(`perl -e 'setpgrp; sleep 5' & echo started`, await workDir(), 300);
    expect(r.timedOut).toBe(true);
    expect(r.output).toContain('started');
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('輸出過長會截斷', async () => {
    const r = await runBash(`head -c 50000 /dev/zero | tr '\\0' a`, await workDir());
    expect(r.output.length).toBeLessThan(MAX_OUTPUT + 100);
    expect(r.output).toContain('已截斷');
  });
});

describe('truncate', () => {
  it('短文字不變', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });
});

describe('read_file / write_file', () => {
  it('寫入時自動建立資料夾，讀取支援相對與絕對路徑', async () => {
    const cwd = await workDir();
    const w = await writeFileTool(cwd).execute!({ path: 'notes/a.md', content: '內容' }, opts);
    expect(w).toMatchObject({ ok: true });
    expect(await readFileTool(cwd).execute!({ path: 'notes/a.md' }, opts)).toEqual({ content: '內容' });
    expect(await readFileTool(cwd).execute!({ path: path.join(cwd, 'notes/a.md') }, opts)).toEqual({ content: '內容' });
  });

  it('檔案不存在時回傳錯誤而不丟例外', async () => {
    const r = await readFileTool(await workDir()).execute!({ path: 'nope.txt' }, opts);
    expect(r).toHaveProperty('error');
  });

  it('讀取過長的檔案會截斷', async () => {
    const cwd = await workDir();
    await writeFile(path.join(cwd, 'big.txt'), 'x'.repeat(50_000));
    const r = (await readFileTool(cwd).execute!({ path: 'big.txt' }, opts)) as unknown as { content: string };
    expect(r.content).toContain('已截斷');
  });
});
