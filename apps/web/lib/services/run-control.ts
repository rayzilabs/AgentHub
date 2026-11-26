import { env } from '@/lib/env';
import { hostFor, loadProjectMachine } from '@/lib/hosts';
import { E2B_TIMEOUT_MS } from '@/lib/hosts/e2b';
import type { HostName, Liveness, RuntimeHost } from '@/lib/hosts/types';
import { HttpError } from '@/lib/http';
import { signProjectToken } from '@/lib/platform-tokens';
import { forwardChat, markRuntimeGone, restartRuntime, RUNTIME_GONE } from '@/lib/project-runtime';
import { ALREADY_READ } from '@/lib/queue';
import { askStop, confirmMachineGone, markRunInterrupted } from '@/lib/run-liveness';
import { runtimeAccessToken } from '@/lib/runtime-session';
import type { Db } from '@/lib/supabase/admin';
import { assertConsultantsUsable } from './projects';
import { getOwnThread, type QueuedView } from './threads';

async function runningRunId(db: Db, threadId: string): Promise<string | null> {
  const { data, error } = await db.from('runs').select('id').eq('thread_id', threadId).eq('status', 'running').maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/** 要 runtime 停下這串對話正在跑的 run；已經沒有在跑就當成功，可重複呼叫 */
export async function stopThreadRun(
  db: Db, userId: string, threadId: string, ask: typeof askStop = askStop, hosts: (n: HostName) => RuntimeHost = hostFor,
): Promise<void> {
  const { project } = await getOwnThread(db, userId, threadId);
  const runId = await runningRunId(db, threadId);
  if (!runId) return;
  const m = project.sprite_url ? await loadProjectMachine(db, project.id) : null;
  let answer = m ? await ask(m, runId, await runtimeAccessToken(db, project.id)) : 'gone';
  // runtime 沒回答：機器整台不見時 run 也不在了，不必要使用者一直重試
  if (answer === 'unknown' && m && (await confirmMachineGone(db, project.id, m, hosts))) answer = 'gone';
  if (answer === 'unknown') throw new HttpError(502, '暫時無法停止，請再試一次');
  if (answer === 'gone') await markRunInterrupted(db, runId);
}

async function runtimeGone(db: Db, projectId: string): Promise<never> {
  await markRuntimeGone(db, projectId);
  throw new HttpError(410, RUNTIME_GONE);
}

/**
 * 把一輪對話交給 runtime：附上專案通行證（呼叫模型代理與創作者 MCP，沒有它對話一定失敗）
 * 與 runtime 帳號的資料庫通行證（權限由 RLS 限定在這個專案）。
 * 連不上時問執行環境：機器不見就回 410；E2B 機器還在（例如冷開機後 runtime 沒在跑）就重啟服務一次再轉送。
 * Sprite 由它自己的服務管理員重啟，不在這裡處理。
 */
export async function forwardToRuntime(
  db: Db,
  projectId: string,
  body: { thread_id: string; text?: string },
  forward: typeof forwardChat = forwardChat,
  hosts: (n: HostName) => RuntimeHost = hostFor,
): Promise<Response> {
  const secret = env.runtimeTokenSecret;
  if (!secret) throw new HttpError(503, '平台尚未設定專案通行證，暫時無法對話');
  const [, dbToken, m] = await Promise.all([
    assertConsultantsUsable(db, projectId), runtimeAccessToken(db, projectId), loadProjectMachine(db, projectId),
  ]);
  if (!m) throw new HttpError(409, 'agent 環境還在準備中，請稍候再送出');
  const host = hosts(m.host);

  if (m.host === 'e2b') {
    // E2B 的逾時不看流量：先延長，避免剛叫醒、runtime 第一次 keepalive 前就被暫停
    let live: Liveness | undefined;
    try {
      live = await host.extend(m, E2B_TIMEOUT_MS.project);
    } catch (e) {
      console.warn('[forward] 延長沙盒存活失敗，照樣轉送', projectId, e);
    }
    if (live === 'gone') return runtimeGone(db, projectId);
  }

  const opts = { projectToken: signProjectToken(projectId, secret), dbToken };
  try {
    return await forward(m, body, opts);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 502) throw e;
    const live = await host.status(m).catch(() => undefined);
    if (live === 'gone') return runtimeGone(db, projectId);
    if (m.host !== 'e2b' || live !== 'running') throw e;
    try {
      await restartRuntime(host, m, projectId);
    } catch (restartError) {
      console.error('[forward] 重啟 runtime 失敗', projectId, restartError);
      throw e;
    }
    return forward(m, body, opts);
  }
}

/**
 * 這串對話沒有 run 在跑、又有排隊訊息時開下一輪。runtime 自己的通行證撐不到下一輪結束，所以由平台重新簽發。
 * 只等 runtime 收下這輪，不等它跑完；同時有兩邊來開時，one_running_run_per_thread 會讓其中一邊回 409。
 */
export async function startQueuedRun(
  db: Db,
  projectId: string,
  threadId: string,
  forward: typeof forwardChat = forwardChat,
): Promise<void> {
  if (await runningRunId(db, threadId)) return;
  const { data, error } = await db.from('queued_messages').select('id').eq('thread_id', threadId).limit(1);
  if (error) throw error;
  // runtime 每輪結束都會呼叫；還沒有機器（不該發生）時安靜結束
  if (data.length === 0 || !(await loadProjectMachine(db, projectId))) return;

  const res = await forwardToRuntime(db, projectId, { thread_id: threadId }, forward);
  await res.body?.cancel();
  if (!res.ok && res.status !== 409) throw new HttpError(502, `無法開始下一輪（HTTP ${res.status}）`);
}

/**
 * chatPending：瀏覽器的上一則訊息還在送出，run 可能還沒建立。這時不能開新的一輪，否則上一則會被 409 退回；那一輪第一步就會讀到排隊訊息。
 * defer：接續要等 runtime 做完準備才有回應，路由用 after() 放到背景，訊息不會卡在畫面上哪裡都看不到。
 */
export async function addQueued(
  db: Db, userId: string, threadId: string, text: string,
  { forward = forwardChat, chatPending = false, defer = (job) => job() }: {
    forward?: typeof forwardChat;
    chatPending?: boolean;
    defer?: (job: () => Promise<void>) => unknown;
  } = {},
): Promise<QueuedView> {
  const { project } = await getOwnThread(db, userId, threadId);
  const { data, error } = await db.from('queued_messages').insert({ thread_id: threadId, text }).select('id, text').single();
  if (error) throw error;
  if (chatPending) return data;

  // runtime 先寫狀態再查排隊，這裡先寫排隊再查狀態，所以兩邊至少一方看得到。
  // 只有上一輪正常完成才接續：停止或失敗後不自動再花額度，由畫面把訊息放回輸入框
  await defer(async () => {
    try {
      const { data: latest, error: runError } = await db.from('runs').select('status').eq('thread_id', threadId)
        .order('started_at', { ascending: false }).limit(1).maybeSingle();
      if (runError) throw runError;
      if (latest?.status === 'succeeded') await startQueuedRun(db, project.id, threadId, forward);
    } catch (e) {
      // 訊息已經存好，不算這次送出失敗；留在排隊區，畫面等不到下一輪就會放回輸入框
      console.error('[queue] 無法開始下一輪', e);
    }
  });
  return data;
}

export async function editQueued(db: Db, userId: string, threadId: string, id: string, text: string): Promise<void> {
  await getOwnThread(db, userId, threadId);
  const { data, error } = await db.from('queued_messages').update({ text }).eq('id', id).eq('thread_id', threadId).select('id');
  if (error) throw error;
  if (data.length === 0) throw new HttpError(409, ALREADY_READ);
}

export async function deleteQueued(db: Db, userId: string, threadId: string, id: string): Promise<void> {
  await getOwnThread(db, userId, threadId);
  const { data, error } = await db.from('queued_messages').delete().eq('id', id).eq('thread_id', threadId).select('id');
  if (error) throw error;
  if (data.length === 0) throw new HttpError(409, ALREADY_READ);
}

/** runtime 對話中定期呼叫：E2B 專案延長沙盒 5 分鐘，Sprite 專案（靠 Tasks API）不做事 */
export async function extendForKeepalive(
  db: Db,
  projectId: string,
  hosts: (n: HostName) => RuntimeHost = hostFor,
): Promise<{ ok: true; state?: Liveness }> {
  const m = await loadProjectMachine(db, projectId);
  if (!m || m.host !== 'e2b') return { ok: true };
  return { ok: true, state: await hosts(m.host).extend(m, E2B_TIMEOUT_MS.project) };
}
