import type { UIMessage } from 'ai';
import { HttpError } from '@/lib/http';
import type { Db } from '@/lib/supabase/admin';
import { getOwnProject, type ProjectRow, type ThreadRow } from './projects';

export type ThreadMessages = { messages: UIMessage[]; running: boolean; error: string | null };

export type MemoryView = { id: string; instance_id: string | null; agent_name: string | null; content: string; created_at: string };

const STALE_RUN_MS = 20 * 60_000;

export async function listThreads(db: Db, userId: string, projectId: string): Promise<ThreadRow[]> {
  await getOwnProject(db, userId, projectId);
  const { data, error } = await db.from('threads').select('id, project_id, title, created_at').eq('project_id', projectId).order('created_at', { ascending: false });
  if (error) throw error;
  return data as ThreadRow[];
}

export async function createThread(db: Db, userId: string, projectId: string, title?: string): Promise<ThreadRow> {
  await getOwnProject(db, userId, projectId);
  const { data, error } = await db
    .from('threads')
    .insert({ project_id: projectId, ...(title ? { title } : {}) })
    .select('id, project_id, title, created_at')
    .single();
  if (error) throw error;
  return data as ThreadRow;
}

export async function getOwnThread(db: Db, userId: string, threadId: string): Promise<{ thread: ThreadRow; project: ProjectRow }> {
  const { data, error } = await db.from('threads').select('id, project_id, title, created_at').eq('id', threadId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, '找不到這串對話');
  const project = await getOwnProject(db, userId, data.project_id).catch(() => {
    throw new HttpError(404, '找不到這串對話');
  });
  return { thread: data as ThreadRow, project };
}

export async function getThreadMessages(db: Db, userId: string, threadId: string): Promise<ThreadMessages> {
  await getOwnThread(db, userId, threadId);
  const [messagesResult, runResult] = await Promise.all([
    db.from('messages').select('ui_message').eq('thread_id', threadId).in('kind', ['user', 'final']).order('created_at'),
    db.from('runs').select('status, error, started_at').eq('thread_id', threadId).order('started_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (messagesResult.error) throw messagesResult.error;
  if (runResult.error) throw runResult.error;

  const messages = messagesResult.data.map((m) => m.ui_message as UIMessage | null).filter((m): m is UIMessage => !!m);
  const run = runResult.data;
  if (!run) return { messages, running: false, error: null };
  if (run.status === 'running') {
    const stale = Date.now() - new Date(run.started_at).getTime() > STALE_RUN_MS;
    return { messages, running: !stale, error: stale ? '這次回覆超過 20 分鐘沒有完成' : null };
  }
  return { messages, running: false, error: run.status === 'failed' ? run.error : null };
}

export async function listMemories(db: Db, userId: string, projectId: string): Promise<MemoryView[]> {
  await getOwnProject(db, userId, projectId);
  const { data, error } = await db
    .from('memories')
    .select('id, instance_id, content, created_at, agent:agent_instances!memories_instance_id_fkey(name)')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(({ agent, ...m }) => ({ ...m, agent_name: (agent as unknown as { name: string } | null)?.name ?? null }) as MemoryView);
}

export async function updateMemory(db: Db, userId: string, projectId: string, memoryId: string, content: string): Promise<void> {
  await getOwnProject(db, userId, projectId);
  const { error } = await db
    .from('memories')
    .update({ content, updated_at: new Date().toISOString() })
    .eq('id', memoryId)
    .eq('project_id', projectId);
  if (error) throw error;
}

export async function deleteMemory(db: Db, userId: string, projectId: string, memoryId: string): Promise<void> {
  await getOwnProject(db, userId, projectId);
  const { error } = await db.from('memories').delete().eq('id', memoryId).eq('project_id', projectId);
  if (error) throw error;
}
