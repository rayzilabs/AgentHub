import { env } from '@/lib/env';
import { runtimeAccessToken } from '@/lib/runtime-session';
import type { Db } from '@/lib/supabase/admin';

export type Liveness = 'active' | 'gone' | 'unknown';
export type RunCheck = (spriteUrl: string, runId: string, projectId: string) => Promise<Liveness>;

const ASK_TIMEOUT_MS = 5_000;
const ASK_INTERVAL_MS = 15_000;
export const INTERRUPTED_ERROR = '執行環境中斷';

/** 問 runtime 一個是非題，回答 body[field]；連不上、逾時、格式不對都是 null */
async function askSprite(
  url: string, field: string, dbToken: string, fetchImpl: typeof fetch, method = 'GET',
): Promise<boolean | null> {
  try {
    const res = await fetchImpl(url, {
      method,
      // authorization 給 Fly 驗證 Sprite 網址（驗證後拿掉，到不了 runtime）；runtime 自己用資料庫通行證確認專案
      headers: { authorization: `Bearer ${env.spritesToken}`, 'x-agenthub-db-token': dbToken },
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const answer = ((await res.json()) as Record<string, unknown>)[field];
    return typeof answer === 'boolean' ? answer : null;
  } catch {
    return null;
  }
}

/**
 * 直接問 Sprite 上的 runtime 這個 run 還在不在（runtime 的 GET /runs/:id）。
 * 只有明確回答「不在」才是 gone；連不上、逾時、格式不對都是 unknown，不能拿來判定死亡。
 */
export async function askRuntime(spriteUrl: string, runId: string, dbToken: string, fetchImpl: typeof fetch = fetch): Promise<Liveness> {
  const active = await askSprite(`${spriteUrl}/runs/${encodeURIComponent(runId)}`, 'active', dbToken, fetchImpl);
  return active === null ? 'unknown' : active ? 'active' : 'gone';
}

/**
 * 要 runtime 停下這個 run（runtime 的 POST /runs/:id/stop）。
 * 只有明確回答 stopped=false 才是 gone；舊版 runtime 沒有這個路由，和連不上一樣算 unknown。
 */
export async function askStop(
  spriteUrl: string, runId: string, dbToken: string, fetchImpl: typeof fetch = fetch,
): Promise<'stopped' | 'gone' | 'unknown'> {
  const stopped = await askSprite(`${spriteUrl}/runs/${encodeURIComponent(runId)}/stop`, 'stopped', dbToken, fetchImpl, 'POST');
  return stopped === null ? 'unknown' : stopped ? 'stopped' : 'gone';
}

const lastAsked = new Map<string, number>();

/** 同一個 run 每 15 秒最多問一次（各 Vercel 實例各自節流，夠用） */
export function shouldAsk(runId: string, now = Date.now()): boolean {
  const last = lastAsked.get(runId);
  if (last !== undefined && now - last < ASK_INTERVAL_MS) return false;
  lastAsked.set(runId, now);
  return true;
}

/** 標成中斷；只改仍是 running 的 run。runtime 之後若照常收尾，它寫入的結果會蓋過這裡 */
export async function markRunInterrupted(db: Db, runId: string): Promise<boolean> {
  const { data, error } = await db.from('runs')
    .update({ status: 'failed', error: INTERRUPTED_ERROR, finished_at: new Date().toISOString() })
    .eq('id', runId).eq('status', 'running').select('id');
  if (error) throw error;
  return data.length > 0;
}

export function defaultRunCheck(db: Db): RunCheck {
  return async (spriteUrl, runId, projectId) => {
    if (!shouldAsk(runId)) return 'unknown';
    return askRuntime(spriteUrl, runId, await runtimeAccessToken(db, projectId));
  };
}
