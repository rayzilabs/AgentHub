import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { signProjectToken } from '@/lib/platform-tokens';
import { askStop, markRunInterrupted } from '@/lib/run-liveness';
import { runtimeAccessToken } from '@/lib/runtime-session';
import { forwardChat } from '@/lib/sprites';
import type { Db } from '@/lib/supabase/admin';
import type { ProjectRow } from './projects';
import { getOwnThread, type QueuedView } from './threads';

const ALREADY_READ = '這則訊息已被讀取';

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

  const secret = env.runtimeTokenSecret;
  if (!secret) throw new HttpError(503, '平台尚未設定專案通行證，暫時無法對話');
  const res = await forward(project.sprite_url, { thread_id: threadId }, {
    projectToken: signProjectToken(project.id, secret),
    dbToken: await runtimeAccessToken(db, project.id),
  });
  await res.body?.cancel();
  if (!res.ok && res.status !== 409) throw new HttpError(502, `無法開始下一輪（HTTP ${res.status}）`);
}

export async function addQueued(
  db: Db, userId: string, threadId: string, text: string, forward: typeof forwardChat = forwardChat,
): Promise<QueuedView> {
  const { project } = await getOwnThread(db, userId, threadId);
  const { data, error } = await db.from('queued_messages').insert({ thread_id: threadId, text }).select('id, text').single();
  if (error) throw error;
  // runtime 先寫狀態再查排隊，這裡先寫排隊再查狀態，所以兩邊至少一方看得到。
  // 訊息已經存好，接續失敗時留在排隊區，畫面會把它放回輸入框，不算這次送出失敗
  await startQueuedRun(db, project, threadId, forward).catch((e) => console.error('[queue] 無法開始下一輪', e));
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
