import { tool } from 'ai';
import { z } from 'zod';
import type { Db } from '../db';

export const MEMORY_PROMPT_LIMIT = 50;

export type MemoryRow = { id: string; instance_id: string | null; content: string; created_at: string };

const visibleTo = (instanceId: string) => `instance_id.is.null,instance_id.eq.${instanceId}`;

export async function loadMemories(db: Db, projectId: string, instanceId: string): Promise<MemoryRow[]> {
  const { data, error } = await db
    .from('memories')
    .select('id, instance_id, content, created_at')
    .eq('project_id', projectId)
    .or(visibleTo(instanceId))
    .order('created_at', { ascending: false })
    .limit(MEMORY_PROMPT_LIMIT);
  if (error) throw error;
  return data;
}

export function formatMemoryBlock(rows: MemoryRow[]): string {
  if (rows.length === 0) return '（目前沒有記憶）';
  return rows.map((r) => `- [${r.instance_id ? '私有' : '專案'}] ${r.content}`).join('\n');
}

export function memoryTools(db: Db, projectId: string, instanceId: string) {
  return {
    remember: tool({
      description:
        '寫入一筆記憶。只記使用者明確說過的事實與偏好，不要記你自己或其他 agent 推論出的內容。scope=private 只有你看得到；scope=project 專案裡所有 agent 都看得到。',
      inputSchema: z.object({
        content: z.string().min(1),
        scope: z.enum(['private', 'project']),
      }),
      execute: async ({ content, scope }) => {
        const { error } = await db.from('memories').insert({
          project_id: projectId,
          instance_id: scope === 'private' ? instanceId : null,
          content,
          created_by_instance_id: instanceId,
        });
        return error ? { error: error.message } : { ok: true };
      },
    }),
    recall: tool({
      description: '用關鍵字搜尋你的私有記憶和專案共用記憶。',
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => {
        const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const { data, error } = await db
          .from('memories')
          .select('instance_id, content, created_at')
          .eq('project_id', projectId)
          .or(visibleTo(instanceId))
          .ilike('content', pattern)
          .order('created_at', { ascending: false })
          .limit(20);
        if (error) return { error: error.message };
        return {
          results: data.map((m) => ({ scope: m.instance_id ? 'private' : 'project', content: m.content, created_at: m.created_at })),
        };
      },
    }),
  };
}
