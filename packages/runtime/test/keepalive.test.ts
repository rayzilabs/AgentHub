import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKeepAlive } from '../src/keepalive';

// Windows 不能在一般路徑開 Unix socket，改用 named pipe
async function sockPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\ka-${randomUUID()}`;
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'ka-')), 'api.sock');
}

async function listen(handler: http.RequestListener) {
  const sock = await sockPath();
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { sock, close };
}

const sprite = (socketPath: string, taskName: string) => ({
  host: 'sprite' as const, taskName, socketPath, platformUrl: 'https://p.test', platformToken: 'tok',
});

describe('startKeepAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('開始時登記、定期更新、結束時取消', async () => {
    const sock = await sockPath();
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

    const keepAlive = await startKeepAlive({ ...sprite(sock, 'run-1'), intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 130));
    await keepAlive.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(calls[0]).toBe('PUT /v1/tasks/run-1 {"expire":"5m"}');
    expect(calls.filter((c) => c.startsWith('PUT')).length).toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)).toBe('DELETE /v1/tasks/run-1 ');
  });

  it('socket 不存在（本機開發）時不丟例外', async () => {
    const keepAlive = await startKeepAlive({ ...sprite('/nonexistent/api.sock', 'run-2'), intervalMs: 50 });
    await expect(keepAlive.stop()).resolves.toBeUndefined();
  });

  it('Tasks API 回傳錯誤狀態碼時記錄警告', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sock, close } = await listen((req, res) => {
      req.resume();
      res.statusCode = 500;
      res.end();
    });
    const keepAlive = await startKeepAlive(sprite(sock, 'run-3'));
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
    const keepAlive = await startKeepAlive({ ...sprite(sock, 'run-4'), requestTimeoutMs: 50 });
    await expect(keepAlive.stop()).resolves.toBeUndefined();
    await close();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(warn).toHaveBeenCalledWith('[keepalive] 登記失敗', expect.stringContaining('沒有回應'));
  });

  it('e2b：立刻與每 interval 送 POST /api/runtime/keepalive，帶 Bearer 專案通行證；stop 只停計時、不送請求', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }));
    const keepAlive = await startKeepAlive({
      host: 'e2b', taskName: 'run-5', socketPath: '/nonexistent/api.sock', platformUrl: 'https://p.test', platformToken: 'proj-tok',
      intervalMs: 50, fetchImpl,
    });
    await new Promise((r) => setTimeout(r, 130));
    await keepAlive.stop();
    const n = fetchImpl.mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(2);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe('https://p.test/api/runtime/keepalive');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer proj-tok');
    }
    await new Promise((r) => setTimeout(r, 120));
    expect(fetchImpl.mock.calls.length).toBe(n);
  });

  it('e2b：請求失敗只警告', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = { host: 'e2b' as const, taskName: 'run-6', socketPath: 'x', platformUrl: 'https://p.test', platformToken: 't', intervalMs: 10_000 };
    const ka1 = await startKeepAlive({ ...base, fetchImpl: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(ka1.stop()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[keepalive] 延長失敗', expect.stringContaining('boom'));
    const ka2 = await startKeepAlive({ ...base, fetchImpl: vi.fn(async () => new Response('x', { status: 500 })) });
    await ka2.stop();
    expect(warn).toHaveBeenCalledWith('[keepalive] 延長失敗', 'HTTP 500');
  });
});
