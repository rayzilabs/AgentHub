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

export type KeepAliveOptions = {
  host: 'sprite' | 'e2b';
  taskName: string;
  socketPath: string;
  platformUrl: string;
  platformToken: string;
  intervalMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** E2B 的逾時不看流量，改請平台延長；結束時什麼都不送，沙盒 5 分鐘後自己暫停 */
async function startPlatformKeepAlive(o: KeepAliveOptions): Promise<{ stop(): Promise<void> }> {
  const timeoutMs = o.requestTimeoutMs ?? KEEPALIVE_REQUEST_TIMEOUT_MS;
  const refresh = () =>
    (o.fetchImpl ?? fetch)(`${o.platformUrl}/api/runtime/keepalive`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.platformToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((res) => {
        void res.body?.cancel();
        if (res.status >= 400) console.warn('[keepalive] 延長失敗', `HTTP ${res.status}`);
      })
      .catch((e: unknown) => {
        console.warn('[keepalive] 延長失敗', errorText(e));
      });

  await refresh();
  const timer = setInterval(refresh, o.intervalMs ?? KEEPALIVE_INTERVAL_MS);
  return { stop: async () => clearInterval(timer) };
}

export async function startKeepAlive(o: KeepAliveOptions): Promise<{ stop(): Promise<void> }> {
  if (o.host === 'e2b') return startPlatformKeepAlive(o);
  const { socketPath, taskName } = o;
  const intervalMs = o.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  const requestTimeoutMs = o.requestTimeoutMs ?? KEEPALIVE_REQUEST_TIMEOUT_MS;
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
