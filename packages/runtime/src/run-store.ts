import type { ModelMessage } from 'ai';
import type { Db } from './db';
import { NotFoundError, RunConflictError } from './errors';
import type { MessageKind } from './types';

export type RunResult = { status: 'succeeded' } | { status: 'cancelled' } | { status: 'failed'; error: string };

export type QueuedMessage = { id: string; text: string };

export const INTERRUPTED_HEADER = '（這一輪被使用者中斷，以下是中斷當時的進度）';

export type NewMessage = {
  thread_id: string;
  run_id: string;
  speaker_instance_id: string | null;
  kind: MessageKind;
  content: string;
  round?: number | null;
  ui_message?: unknown;
  tool_events?: unknown[];
};

export async function assertThreadInProject(db: Db, threadId: string, projectId: string): Promise<void> {
  const { data, error } = await db
    .from('threads')
    .select('id')
    .eq('id', threadId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError(`找不到對話 ${threadId}`);
}

export async function createRun(db: Db, threadId: string): Promise<string> {
  const { data, error } = await db.from('runs').insert({ thread_id: threadId }).select('id').single();
  if (error) {
    if (error.code === '23505') throw new RunConflictError('這串對話還在處理中');
    throw error;
  }
  return data.id;
}

export async function finishRun(db: Db, runId: string, result: RunResult): Promise<void> {
  const { error } = await db
    .from('runs')
    .update({
      status: result.status,
      error: result.status === 'failed' ? result.error : null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) throw error;
}

export async function insertMessage(db: Db, m: NewMessage): Promise<string> {
  const { data, error } = await db.from('messages').insert(m).select('id').single();
  if (error) throw error;
  return data.id;
}

export type MessagePatch = { content: string; ui_message: unknown; tool_events: unknown[] };

export async function updateMessage(db: Db, id: string, patch: MessagePatch): Promise<void> {
  const { error } = await db.from('messages').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

/** 只推進 updated_at，當作 runtime 還活著的心跳 */
export async function touchMessage(db: Db, id: string): Promise<void> {
  const { error } = await db.from('messages').update({ updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function deleteMessage(db: Db, id: string): Promise<void> {
  const { error } = await db.from('messages').delete().eq('id', id);
  if (error) throw error;
}

type HistoryRow = { kind: MessageKind; content: string; run_id: string | null };

/** final 在一輪開始就插入，時間比插話早，要移到插話之後，之後的輪次才看得出插話有被回答 */
function placeInterjections(rows: HistoryRow[]): HistoryRow[] {
  const placed: HistoryRow[] = [];
  for (const row of rows) {
    const finalAt = row.kind === 'interjection' ? placed.findIndex((m) => m.kind === 'final' && m.run_id === row.run_id) : -1;
    if (finalAt === -1) placed.push(row);
    else placed.splice(finalAt, 0, row);
  }
  return placed;
}

/** 被中斷的 run 各自的顧問報告（沒有報告也會列出）；報告不計入歷史則數上限 */
async function interruptedReports(db: Db, rows: HistoryRow[]): Promise<Map<string, string[]>> {
  const runIds = [...new Set(rows.flatMap((r) => (r.run_id ? [r.run_id] : [])))];
  const { data: runs, error } = await db.from('runs').select('id').in('id', runIds).eq('status', 'cancelled');
  if (error) throw error;
  const reports = new Map<string, string[]>(runs.map((r) => [r.id, []]));
  if (reports.size === 0) return reports;

  const { data: speeches, error: speechesError } = await db
    .from('messages')
    .select('run_id, speaker_instance_id, content')
    .in('run_id', [...reports.keys()])
    .in('kind', ['delegation', 'discussion'])
    .order('created_at');
  if (speechesError) throw speechesError;
  const speakerIds = [...new Set(speeches.flatMap((m) => (m.speaker_instance_id ? [m.speaker_instance_id] : [])))];
  const { data: speakers, error: speakersError } = await db.from('agent_instances').select('id, name').in('id', speakerIds);
  if (speakersError) throw speakersError;
  const names = new Map(speakers.map((a) => [a.id, a.name]));
  for (const m of speeches) {
    if (m.content) reports.get(m.run_id)!.push(`【${names.get(m.speaker_instance_id) ?? '顧問'}】\n${m.content}`);
  }
  return reports;
}

function interruptedText(finalText: string, reports: string[]): string {
  const parts = [finalText, ...reports].filter(Boolean);
  return parts.length ? [INTERRUPTED_HEADER, ...parts].join('\n\n') : '';
}

export async function loadHistory(db: Db, threadId: string, limit = 50): Promise<ModelMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('kind, content, run_id')
    .eq('thread_id', threadId)
    .in('kind', ['user', 'final', 'interjection'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = data.reverse();
  // 截斷後的視窗可能從 assistant 回覆開始，對話歷史必須從使用者發言開始
  const firstUser = rows.findIndex((m) => m.kind === 'user');
  const arranged = placeInterjections(rows.slice(firstUser === -1 ? rows.length : firstUser));

  for (const [runId, reports] of await interruptedReports(db, arranged)) {
    const finalAt = arranged.findIndex((m) => m.kind === 'final' && m.run_id === runId);
    if (finalAt !== -1) {
      arranged[finalAt] = { ...arranged[finalAt], content: interruptedText(arranged[finalAt].content, reports) };
    } else {
      const lastAt = arranged.map((m) => m.run_id).lastIndexOf(runId);
      arranged.splice(lastAt + 1, 0, { kind: 'final', run_id: runId, content: interruptedText('', reports) });
    }
  }

  // 沒有內容的 final 是 runtime 中途崩潰留下的佔位列，不放進對話歷史
  return arranged
    .filter((m) => m.kind !== 'final' || m.content !== '')
    .map((m): ModelMessage => (m.kind === 'final' ? { role: 'assistant', content: m.content } : { role: 'user', content: m.content }));
}

/** 取走就是刪除：同一列只會被一方取走，所以同一則訊息不會讀到兩次 */
export async function takeQueued(db: Db, threadId: string): Promise<QueuedMessage[]> {
  const { data, error } = await db.from('queued_messages').delete().eq('thread_id', threadId).select('id, text, created_at');
  if (error) throw error;
  return data
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map(({ id, text }) => ({ id, text }));
}

export async function hasQueued(db: Db, threadId: string): Promise<boolean> {
  const { data, error } = await db.from('queued_messages').select('id').eq('thread_id', threadId).limit(1);
  if (error) throw error;
  return data.length > 0;
}

export async function failRunningRuns(db: Db, projectId: string, reason: string): Promise<number> {
  const { data: threads, error: threadsError } = await db.from('threads').select('id').eq('project_id', projectId);
  if (threadsError) throw threadsError;
  if (threads.length === 0) return 0;
  const { data, error } = await db
    .from('runs')
    .update({ status: 'failed', error: reason, finished_at: new Date().toISOString() })
    .eq('status', 'running')
    .in('thread_id', threads.map((t) => t.id))
    .select('id');
  if (error) throw error;
  return data.length;
}
