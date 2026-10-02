import http from 'node:http';
import { errorText } from './errors';

export const KEEPALIVE_INTERVAL_MS = 120_000;
export const KEEPALIVE_REQUEST_TIMEOUT_MS = 5_000;

function call(socketPath: string, method: string, urlPath: string, timeoutMs: number, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, host: 'sprite', path: urlPath, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Tasks API 超過 ${timeoutMs / 1000} 秒沒有回應`)));
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

export async function startKeepAlive(
  socketPath: string,
  taskName: string,
  intervalMs = KEEPALIVE_INTERVAL_MS,
  requestTimeoutMs = KEEPALIVE_REQUEST_TIMEOUT_MS,
): Promise<{ stop(): Promise<void> }> {
  const taskPath = `/v1/tasks/${encodeURIComponent(taskName)}`;
  const warnOnErrorStatus = (label: string) => (status: number) => {
    if (status >= 400) console.warn(`[keepalive] ${label}`, `HTTP ${status}`);
  };
  const refresh = () =>
    call(socketPath, 'PUT', taskPath, requestTimeoutMs, { expire: '5m' })
      .then(warnOnErrorStatus('登記失敗'))
      .catch((e: unknown) => {
        console.warn('[keepalive] 登記失敗', errorText(e));
      });

  await refresh();
  const timer = setInterval(refresh, intervalMs);
  return {
    stop: async () => {
      clearInterval(timer);
      // 連不上 socket（本機開發）時登記就已經警告過，這裡不再重複
      await call(socketPath, 'DELETE', taskPath, requestTimeoutMs)
        .then(warnOnErrorStatus('取消登記失敗'))
        .catch(() => undefined);
    },
  };
}
