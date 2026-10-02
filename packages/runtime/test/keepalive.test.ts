import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKeepAlive } from '../src/keepalive';

async function listen(handler: http.RequestListener) {
  const sock = path.join(await mkdtemp(path.join(os.tmpdir(), 'ka-')), 'api.sock');
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { sock, close };
}

describe('startKeepAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('開始時登記、定期更新、結束時取消', async () => {
    const sock = path.join(await mkdtemp(path.join(os.tmpdir(), 'ka-')), 'api.sock');
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url} ${body}`);
        res.statusCode = req.method === 'DELETE' ? 204 : 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));

    const keepAlive = await startKeepAlive(sock, 'run-1', 50);
    await new Promise((r) => setTimeout(r, 130));
    await keepAlive.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(calls[0]).toBe('PUT /v1/tasks/run-1 {"expire":"5m"}');
    expect(calls.filter((c) => c.startsWith('PUT')).length).toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)).toBe('DELETE /v1/tasks/run-1 ');
  });

  it('socket 不存在（本機開發）時不丟例外', async () => {
    const keepAlive = await startKeepAlive('/nonexistent/api.sock', 'run-2', 50);
    await expect(keepAlive.stop()).resolves.toBeUndefined();
  });

  it('Tasks API 回傳錯誤狀態碼時記錄警告', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sock, close } = await listen((req, res) => {
      req.resume();
      res.statusCode = 500;
      res.end();
    });
    const keepAlive = await startKeepAlive(sock, 'run-3', 10_000);
    await keepAlive.stop();
    await close();
    expect(warn).toHaveBeenCalledWith('[keepalive] 登記失敗', 'HTTP 500');
    expect(warn).toHaveBeenCalledWith('[keepalive] 取消登記失敗', 'HTTP 500');
  });

  it('Tasks API 沒有回應時逾時放棄，記錄警告而不丟例外', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sock, close } = await listen(() => {
      // 永遠不回應
    });
    const start = Date.now();
    const keepAlive = await startKeepAlive(sock, 'run-4', 10_000, 50);
    await expect(keepAlive.stop()).resolves.toBeUndefined();
    await close();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(warn).toHaveBeenCalledWith('[keepalive] 登記失敗', expect.stringContaining('沒有回應'));
  });
});
