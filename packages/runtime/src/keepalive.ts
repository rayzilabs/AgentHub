import http from 'node:http';

export const KEEPALIVE_INTERVAL_MS = 120_000;

function call(socketPath: string, method: string, urlPath: string, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, host: 'sprite', path: urlPath, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

export async function startKeepAlive(
  socketPath: string,
  taskName: string,
  intervalMs = KEEPALIVE_INTERVAL_MS,
): Promise<{ stop(): Promise<void> }> {
  const taskPath = `/v1/tasks/${encodeURIComponent(taskName)}`;
  const refresh = () =>
    call(socketPath, 'PUT', taskPath, { expire: '5m' }).catch((e: Error) => {
      console.warn('[keepalive] 登記失敗', e.message);
    });

  await refresh();
  const timer = setInterval(refresh, intervalMs);
  return {
    stop: async () => {
      clearInterval(timer);
      await call(socketPath, 'DELETE', taskPath).catch(() => undefined);
    },
  };
}
