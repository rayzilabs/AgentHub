import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { signProjectToken } from '@/lib/platform-tokens';
import { ALREADY_READ } from '@/lib/queue';
import { askStop, markRunInterrupted } from '@/lib/run-liveness';
import { runtimeAccessToken } from '@/lib/runtime-session';
import { forwardChat } from '@/lib/sprites';
import type { Db } from '@/lib/supabase/admin';
import { assertConsultantsUsable, type ProjectRow } from './projects';
import { getOwnThread, type QueuedView } from './threads';

async function runningRunId(db: Db, threadId: string): Promise<string | null> {
  const { data, error } = await db.from('runs').select('id').eq('thread_id', threadId).eq('status', 'running').maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/** 要 runtime 停下這串對話正在跑的 run；已經沒有在跑就當成功，可重複呼叫 */
export async function stopThreadRun(db: Db, userId: string, threadId: string, ask: typeof askStop = askStop): Promise<void> {
  const { project } = await getOwnThread(db, userId, threadId);
  const runId = await runningRunId(db, threadId);
  if (!runId) return;
  const answer = project.sprite_url ? await ask(project.sprite_url, runId, await runtimeAccessToken(db, project.id)) : 'gone';
  if (answer === 'unknown') throw new HttpError(502, '暫時無法停止，請再試一次');
  if (answer === 'gone') await markRunInterrupted(db, runId);
}

/**
 * 這串對話沒有 run 在跑、又有排隊訊息時開下一輪。runtime 自己的通行證撐不到下一輪結束，所以由平台重新簽發。
 * 只等 runtime 收下這輪，不等它跑完；同時有兩邊來開時，one_running_run_per_thread 會讓其中一邊回 409。
 */
export async function startQueuedRun(
  db: Db,
  project: Pick<ProjectRow, 'id' | 'sprite_url'>,
  threadId: string,
  forward: typeof forwardChat = forwardChat,
): Promise<void> {
  if (await runningRunId(db, threadId)) return;
  const { data, error } = await db.from('queued_messages').select('id').eq('thread_id', threadId).limit(1);
  if (error) throw error;
  if (data.length === 0 || !project.sprite_url) return;

  await assertConsultantsUsable(db, project.id);
  const secret = env.runtimeTokenSecret;
  if (!secret) throw new HttpError(503, '平台尚未設定專案通行證，暫時無法對話');
  const res = await forward(project.sprite_url, { thread_id: threadId }, {
    projectToken: signProjectToken(project.id, secret),
    dbToken: await runtimeAccessToken(db, project.id),
  });
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
      if (latest?.status === 'succeeded') await startQueuedRun(db, project, threadId, forward);
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
