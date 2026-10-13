import { APIError, SpritesClient, type Sprite } from '@fly/sprites';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { setSpriteState } from '@/lib/services/projects';
import type { Db } from '@/lib/supabase/admin';

export const RUNTIME_OBJECT = 'main.js';
export const WORKSPACE = '/workspace';
export const SANDBOX_USER = 'agent';
const SERVICE = 'runtime';
const HEALTH_TIMEOUT_MS = 90_000;
const RETRYABLE = new Set([502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SDK 的 APIError 會把 API 回傳的錯誤物件當成 message（變成 "[object Object]"），改取裡面的訊息與狀態碼。 */
export function errorText(e: unknown): string {
  if (e instanceof APIError) {
    const detail = e.errorCode as unknown;
    const message = detail && typeof detail === 'object' && 'message' in detail ? String(detail.message) : e.message;
    return e.statusCode ? `Sprites API ${e.statusCode}：${message}` : message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Sprites API 偶爾回 5xx（例如 internal_error），稍後重試通常就會成功。 */
export async function retryTransient<T>(fn: () => Promise<T>, delayMs = 2000, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const transient = e instanceof APIError && e.statusCode !== undefined && e.statusCode >= 500;
      if (!transient || attempt >= attempts) throw e;
      await sleep(delayMs);
    }
  }
}

/** Sprites API 回 404 時 SDK 一律丟出帶 statusCode 的 APIError；訊息比對只作為保守的備援（不比對 "404"，UUID 可能含這三個字）。 */
export function isNotFound(e: unknown): boolean {
  if (e instanceof APIError && e.statusCode !== undefined) return e.statusCode === 404;
  return /\bnot found\b/i.test(errorText(e));
}

export function spriteName(projectId: string): string {
  return `agenthub-${projectId}`;
}

export function runtimeEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n';
}

/**
 * 建立沙盒帳號與工作區（可重複執行），以 runtime 帳號透過 sudo 執行。
 * 工作區由 runtime 帳號擁有、workspace 群組可寫；agent 只靠群組權限進入，沒有 sudo，進不了 runtime 目錄。
 */
export function sandboxSetupScript(base: string): string {
  const q = (p: string) => `'${p}'`;
  return [
    'set -euo pipefail',
    `id -u ${SANDBOX_USER} >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash ${SANDBOX_USER}`,
    'getent group workspace >/dev/null || sudo groupadd workspace',
    `sudo usermod -aG workspace ${SANDBOX_USER}`,
    `sudo mkdir -p ${WORKSPACE}/agents ${WORKSPACE}/shared`,
    // 舊版的工作區在 runtime 目錄底下；搬過來，顧問寫出的檔案不會遺失
    `if [ -d ${q(`${base}/agents`)} ]; then sudo cp -a ${q(`${base}/agents/.`)} ${WORKSPACE}/agents/ && sudo rm -rf ${q(`${base}/agents`)}; fi`,
    `if [ -d ${q(`${base}/shared`)} ]; then sudo cp -a ${q(`${base}/shared/.`)} ${WORKSPACE}/shared/ && sudo rm -rf ${q(`${base}/shared`)}; fi`,
    `sudo chown -R "$(id -un)":workspace ${WORKSPACE}`,
    `sudo chmod -R g+rwX,o-rwx ${WORKSPACE}/agents ${WORKSPACE}/shared`,
    `sudo find ${WORKSPACE}/agents ${WORKSPACE}/shared -type d -exec chmod g+s {} +`,
    `sudo chmod 2770 ${WORKSPACE}/agents ${WORKSPACE}/shared`,
    `sudo chmod 755 ${WORKSPACE}`,
    // Sprite 內部 API 能建立以 runtime 帳號執行的服務；只留給 runtime 群組（runtime 啟動與每次 run 前也會再確認）
    `if [ -S /.sprite/api.sock ]; then sudo chgrp "$(id -g)" /.sprite/api.sock && sudo chmod 660 /.sprite/api.sock; fi`,
    // .env 可能由檔案 API 以別的帳號寫入，先改回 runtime 帳號再收緊
    `sudo chown "$(id -un)" ${q(`${base}/.env`)}`,
    `chmod 600 ${q(`${base}/.env`)}`,
    `chmod 700 ${q(base)}`,
  ].join('\n');
}

function client() {
  return new SpritesClient(env.spritesToken);
}

async function getOrCreateSprite(name: string): Promise<Sprite> {
  const c = client();
  try {
    return await c.getSprite(name);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  return c.createSprite(name, { urlSettings: { auth: 'sprite' } });
}

export async function installRuntime(db: Db, sprite: Sprite, projectId: string, runtimeObject = RUNTIME_OBJECT): Promise<string> {
  const { stdout } = await sprite.execFile('bash', ['-lc', 'printf %s "$HOME"']);
  const base = `${String(stdout).trim()}/agenthub`;
  const { data, error } = await db.storage.from('runtime').createSignedUrl(runtimeObject, 600);
  if (error) throw new Error(`找不到 runtime 安裝檔：${error.message}`);
  await sprite.execFile('bash', ['-lc', `mkdir -p '${base}' && curl -fsSL '${data.signedUrl}' -o '${base}/main.js'`]);
  await sprite.filesystem(base).writeFile('.env', runtimeEnvFile({
    PROJECT_ID: projectId,
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_SECRET_KEY: env.supabaseSecretKey,
    VERTEX_API_EXPRESS_MODE_KEY: env.vertexKey,
    AGENTS_ROOT: `${WORKSPACE}/agents`,
    SHARED_ROOT: `${WORKSPACE}/shared`,
    SANDBOX_USER,
  }));
  await sprite.execFile('bash', ['-lc', sandboxSetupScript(base)]);
  const logs = await sprite.createService(SERVICE, {
    cmd: 'node',
    args: [`--env-file=${base}/.env`, `${base}/main.js`],
    httpPort: 8080,
  }, '10s');
  await logs.processAll(() => {});
  // 重新佈建已存在的 Sprite 時，createService 不會重啟正在跑的程序；重新啟動才會載入剛下載的 main.js 與 .env
  const restartLogs = await sprite.restartService(SERVICE, '10s');
  await restartLogs.processAll(() => {});
  return base;
}

async function waitForHealth(url: string, projectId: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, {
        headers: { authorization: `Bearer ${env.spritesToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json()) as { project_id?: string };
        if (body.project_id === projectId) return;
        last = `health 回傳的專案不符：${body.project_id}`;
      } else {
        last = `health 回應 ${res.status}`;
      }
    } catch (e) {
      last = errorText(e);
    }
    await sleep(2000);
  }
  throw new Error(`agent 環境啟動逾時（${last}）`);
}

export async function provisionProject(db: Db, projectId: string): Promise<void> {
  const name = spriteName(projectId);
  try {
    await setSpriteState(db, projectId, { sprite_status: 'provisioning', sprite_error: null, sprite_name: name });
    const sprite = await retryTransient(() => getOrCreateSprite(name));
    if (!sprite.url) throw new Error('agent 環境沒有對外網址');
    await installRuntime(db, sprite, projectId);
    await waitForHealth(sprite.url, projectId);
    await setSpriteState(db, projectId, { sprite_status: 'ready', sprite_url: sprite.url });
  } catch (e) {
    console.error('[provision]', projectId, e);
    await setSpriteState(db, projectId, { sprite_status: 'error', sprite_error: errorText(e) }).catch(() => undefined);
  }
}

export async function destroyProjectSprite(name: string): Promise<void> {
  if (!name.startsWith('agenthub-')) throw new Error(`拒絕刪除非 AgentHub 的 Sprite：${name}`);
  await client().deleteSprite(name).catch((e) => {
    if (!isNotFound(e)) throw e;
  });
}

export async function forwardChat(
  spriteUrl: string,
  body: { thread_id: string; text: string },
  opts: { token?: string; fetchImpl?: typeof fetch; retryDelayMs?: number } = {},
): Promise<Response> {
  const token = opts.token ?? env.spritesToken;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delay = opts.retryDelayMs ?? 1000;
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(`${spriteUrl}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!RETRYABLE.has(res.status)) return res;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = errorText(e);
    }
    if (attempt < 2) await sleep(delay);
  }
  throw new HttpError(502, `agent 環境無法連線，請稍後再試（${last}）`);
}
