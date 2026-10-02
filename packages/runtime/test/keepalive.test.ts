import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startKeepAlive } from '../src/keepalive';

describe('startKeepAlive', () => {
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
});
