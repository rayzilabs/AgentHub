import { APIError, SpritesClient, type Sprite } from '@fly/sprites';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { setSpriteState } from '@/lib/services/projects';
import type { Db } from '@/lib/supabase/admin';

export const RUNTIME_OBJECT = 'main.js';
const SERVICE = 'runtime';
const HEALTH_TIMEOUT_MS = 90_000;
const RETRYABLE = new Set([502, 503, 504]);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export async function installRuntime(db: Db, sprite: Sprite, projectId: string): Promise<string> {
  const { stdout } = await sprite.execFile('bash', ['-lc', 'printf %s "$HOME"']);
  const base = `${String(stdout).trim()}/agenthub`;
  const { data, error } = await db.storage.from('runtime').createSignedUrl(RUNTIME_OBJECT, 600);
  if (error) throw new Error(`找不到 runtime 安裝檔：${error.message}`);
  await sprite.execFile('bash', ['-lc', `mkdir -p '${base}' && curl -fsSL '${data.signedUrl}' -o '${base}/main.js'`]);
  await sprite.filesystem(base).writeFile('.env', runtimeEnvFile({
    PROJECT_ID: projectId,
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_SECRET_KEY: env.supabaseSecretKey,
    VERTEX_API_EXPRESS_MODE_KEY: env.vertexKey,
    AGENTS_ROOT: `${base}/agents`,
    SHARED_ROOT: `${base}/shared`,
  }));
  const logs = await sprite.createService(SERVICE, {
    cmd: 'node',
    args: [`--env-file=${base}/.env`, `${base}/main.js`],
    httpPort: 8080,
  }, '10s');
  await logs.processAll(() => {});
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
    const sprite = await getOrCreateSprite(name);
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
