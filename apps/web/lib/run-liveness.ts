import { hostFor } from '@/lib/hosts';
import type { HostName, Machine, RuntimeHost } from '@/lib/hosts/types';
import { markRuntimeGone } from '@/lib/project-runtime';
import { runtimeAccessToken } from '@/lib/runtime-session';
import type { Db } from '@/lib/supabase/admin';

export type Liveness = 'active' | 'gone' | 'unknown';
export type RunCheck = (m: Machine, runId: string, projectId: string) => Promise<Liveness>;

const ASK_TIMEOUT_MS = 5_000;
const ASK_INTERVAL_MS = 15_000;
export const INTERRUPTED_ERROR = '執行環境中斷';

/** 問 runtime 一個是非題，回答 body[field]；連不上、逾時、格式不對都是 null */
async function askMachine(
  m: Machine, path: string, field: string, dbToken: string, fetchImpl: typeof fetch, method = 'GET',
): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`${m.url}${path}`, {
      method,
      // 邊緣標頭給 Fly（驗證後拿掉，到不了 runtime）或 E2B 驗證網址；runtime 自己用資料庫通行證確認專案
      headers: { ...hostFor(m.host).edgeHeaders(m), 'x-agenthub-db-token': dbToken },
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
 * 直接問機器上的 runtime 這個 run 還在不在（runtime 的 GET /runs/:id）。
 * 只有明確回答「不在」才是 gone；連不上、逾時、格式不對都是 unknown，不能拿來判定死亡。
 */
export async function askRuntime(m: Machine, runId: string, dbToken: string, fetchImpl: typeof fetch = fetch): Promise<Liveness> {
  const active = await askMachine(m, `/runs/${encodeURIComponent(runId)}`, 'active', dbToken, fetchImpl);
  return active === null ? 'unknown' : active ? 'active' : 'gone';
}

/**
 * 要 runtime 停下這個 run（runtime 的 POST /runs/:id/stop）。
 * 只有明確回答 stopped=false 才是 gone；舊版 runtime 沒有這個路由，和連不上一樣算 unknown。
 */
export async function askStop(
  m: Machine, runId: string, dbToken: string, fetchImpl: typeof fetch = fetch,
): Promise<'stopped' | 'gone' | 'unknown'> {
  const stopped = await askMachine(m, `/runs/${encodeURIComponent(runId)}/stop`, 'stopped', dbToken, fetchImpl, 'POST');
  return stopped === null ? 'unknown' : stopped ? 'stopped' : 'gone';
}

/**
 * runtime 沒有回答時問執行環境這台機器還在不在；確認不見就把專案標成錯誤（RUNTIME_GONE）。
 * 執行環境 API 出錯不算不見。
 */
export async function confirmMachineGone(
  db: Db, projectId: string, m: Machine, hosts: (n: HostName) => RuntimeHost = hostFor,
): Promise<boolean> {
  if ((await hosts(m.host).status(m).catch(() => undefined)) !== 'gone') return false;
  await markRuntimeGone(db, projectId);
  return true;
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

export function defaultRunCheck(db: Db, hosts: (n: HostName) => RuntimeHost = hostFor): RunCheck {
  return async (m, runId, projectId) => {
    if (!shouldAsk(runId)) return 'unknown';
    const answer = await askRuntime(m, runId, await runtimeAccessToken(db, projectId));
    // 只有 runtime 沒回答時才多問執行環境；機器不見時這個 run 也不會再有結果
    if (answer === 'unknown' && (await confirmMachineGone(db, projectId, m, hosts))) return 'gone';
    return answer;
  };
}
