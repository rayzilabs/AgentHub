import type { ModelMessage } from 'ai';
import type { Db } from './db';
import { NotFoundError, RunConflictError } from './errors';
import type { MessageKind } from './types';

export type RunResult = { status: 'succeeded' } | { status: 'failed'; error: string };

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

export async function loadHistory(db: Db, threadId: string, limit = 50): Promise<ModelMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('kind, content')
    .eq('thread_id', threadId)
    .in('kind', ['user', 'final'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data
    .reverse()
    .map((m): ModelMessage => (m.kind === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content }));
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
