import { setTimeout as sleep } from 'node:timers/promises';
import { APIError, SpritesClient, type Sprite } from '@fly/sprites';
import { env } from '@/lib/env';
import type { Liveness, Machine, MachineKind, RuntimeHost, ServiceSpec } from './types';

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

type SpritesLike = Pick<SpritesClient, 'getSprite' | 'createSprite' | 'deleteSprite'>;

/** 已存在就沿用，否則建立（網址要通過 Fly 驗證） */
export async function getOrCreateSprite(c: SpritesLike, name: string): Promise<Sprite> {
  try {
    return await c.getSprite(name);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  return c.createSprite(name, { urlSettings: { auth: 'sprite' } });
}

/** 只刪名稱以 prefix 開頭的 Sprite；已經不在就算成功 */
export async function deleteSpriteIfExists(c: SpritesLike, name: string, prefix: string): Promise<void> {
  if (!name.startsWith(prefix)) throw new Error(`拒絕刪除不是 ${prefix} 開頭的 Sprite：${name}`);
  await c.deleteSprite(name).catch((e) => {
    if (!isNotFound(e)) throw e;
  });
}

/** 服務不存在時回傳 null */
export async function findService(sprite: Sprite, name: string) {
  return sprite.getService(name).catch((e: unknown) => {
    if (isNotFound(e)) return null;
    throw e;
  });
}

export function createSpriteHost(deps?: SpritesLike): RuntimeHost {
  const client = (): SpritesLike => deps ?? new SpritesClient(env.spritesToken);
  const sprite = (m: Machine): Promise<Sprite> => retryTransient(() => client().getSprite(m.name));

  return {
    name: 'sprite',

    async create(claim: string, _kind: MachineKind): Promise<Machine> {
      const s = await retryTransient(() => getOrCreateSprite(client(), claim));
      if (!s.url) throw new Error('Sprite 沒有對外網址');
      return { host: 'sprite', name: claim, url: s.url, token: null };
    },

    async destroy(name, prefix) {
      await deleteSpriteIfExists(client(), name, prefix);
    },

    async exec(m, script, opts) {
      const { stdout } = await (await sprite(m)).execFile('bash', ['-lc', script], opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined);
      return String(stdout);
    },

    async writeFile(m, path, content) {
      await (await sprite(m)).filesystem('/').writeFile(path, content);
    },

    async startService(m, spec: ServiceSpec) {
      const s = await sprite(m);
      const config = { cmd: spec.cmd, args: spec.args, ...(spec.httpPort ? { httpPort: spec.httpPort } : {}) };
      const existing = await findService(s, spec.name);
      // Sprites API 不准用 PUT 改既有服務的設定（409）；設定不同就先刪掉
      if (existing && (existing.cmd !== config.cmd || (existing.args ?? []).join('\0') !== config.args.join('\0'))) {
        await s.deleteService(spec.name);
      }
      const logs = await s.createService(spec.name, config, '10s');
      await logs.processAll(() => {});
      // createService 不會重啟正在跑的程序；重新啟動才會載入剛寫入的檔案
      const restartLogs = await s.restartService(spec.name, '10s');
      await restartLogs.processAll(() => {});
    },

    async hasService(m, name) {
      return (await findService(await sprite(m), name)) !== null;
    },

    async restartService(m, name) {
      const logs = await (await sprite(m)).restartService(name, '5s');
      await logs.processAll(() => {});
    },

    async serviceLog(m, name, lines) {
      const logs = await (await sprite(m)).getServiceLogs(name, { lines, duration: '1s' });
      const out: string[] = [];
      await logs.processAll((e) => {
        if ((e.type === 'stdout' || e.type === 'stderr') && e.data) out.push(e.data);
      });
      return out.join('').trimEnd();
    },

    async extend(): Promise<Liveness> {
      return 'running';
    },

    async status(m): Promise<Liveness> {
      try {
        await retryTransient(() => client().getSprite(m.name));
        return 'running';
      } catch (e) {
        if (isNotFound(e)) return 'gone';
        throw e;
      }
    },

    edgeHeaders() {
      return { authorization: `Bearer ${env.spritesToken}` };
    },
  };
}
