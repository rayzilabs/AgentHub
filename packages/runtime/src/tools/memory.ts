import { tool } from 'ai';
import { z } from 'zod';
import type { Db } from '../db';

export const MEMORY_INDEX_LIMIT = 200;
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export type MemoryRow = {
  id: string;
  instance_id: string | null;
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  updated_at: string;
};
export type MemoryIndex = { rows: MemoryRow[]; omitted: number };

type Scope = 'private' | 'project';
const SCOPE_LABEL: Record<Scope, string> = { private: '私有', project: '專案' };

const visibleTo = (instanceId: string) => `instance_id.is.null,instance_id.eq.${instanceId}`;
const scopeOf = (row: { instance_id: string | null }): Scope => (row.instance_id ? 'private' : 'project');

export async function loadMemoryIndex(db: Db, projectId: string, instanceId: string, limit = MEMORY_INDEX_LIMIT): Promise<MemoryIndex> {
  const { data, error, count } = await db
    .from('memories')
    .select('id, instance_id, name, description, type, content, updated_at', { count: 'exact' })
    .eq('project_id', projectId)
    .or(visibleTo(instanceId))
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return { rows: data as MemoryRow[], omitted: Math.max(0, (count ?? data.length) - data.length) };
}

export function formatMemoryIndex(index: MemoryIndex): string {
  if (index.rows.length === 0) return '（目前沒有記憶）';
  const lines = index.rows.map((r) => `- [${SCOPE_LABEL[scopeOf(r)]}/${r.type}] ${r.name} — ${r.description}`);
  if (index.omitted > 0) lines.push(`（還有 ${index.omitted} 筆較舊的記憶沒有列出，可以用 memory_read 依名稱讀取）`);
  return lines.join('\n');
}

const scopeField = z.enum(['private', 'project']).describe('private 只有你看得到；project 專案裡所有 agent 都看得到');
const nameField = z.string().trim().min(1).max(64).regex(/^[^\r\n]+$/, '名稱不能換行')
  .describe('簡短的英文小寫加連字號，例如 user-profile、report-style');

export function memoryTools(db: Db, projectId: string, instanceId: string) {
  /** 只會選到自己 scope 的那一筆：私有記憶限自己，專案記憶限 instance_id 為 null */
  const inScope = (scope: Scope, name: string) => {
    const q = db.from('memories').select('id').eq('project_id', projectId).eq('name', name);
    return scope === 'private' ? q.eq('instance_id', instanceId) : q.is('instance_id', null);
  };

  return {
    memory_write: tool({
      description:
        '寫入一筆記憶。同一個 scope 已有同名記憶就更新它（改內容、說明、類型），沒有就新增。寫之前先看記憶索引，相同主題用同一個名稱更新，不要新增重複的。',
      inputSchema: z.object({
        name: nameField,
        scope: scopeField,
        type: z.enum(MEMORY_TYPES),
        description: z.string().trim().min(1).max(200).describe('一行說明，之後看索引就能判斷相不相關'),
        content: z.string().trim().min(1).max(5000),
      }),
      execute: async ({ name, scope, type, description, content }) => {
        const update = async (id: string) => {
          // updated_at 由資料庫觸發器設定
          const { error } = await db.from('memories').update({ content, description, type }).eq('id', id);
          return error ? { error: error.message } : { ok: true, action: 'updated' as const };
        };
        const { data: existing, error: findError } = await inScope(scope, name).maybeSingle();
        if (findError) return { error: findError.message };
        if (existing) return update(existing.id);

        const { error } = await db.from('memories').insert({
          project_id: projectId,
          instance_id: scope === 'private' ? instanceId : null,
          name, description, type, content,
          created_by_instance_id: instanceId,
        });
        if (!error) return { ok: true, action: 'created' as const };
        // 同時有另一個 agent 剛寫入同名記憶：改成更新那一筆
        if (error.code !== '23505') return { error: error.message };
        const { data: raced } = await inScope(scope, name).maybeSingle();
        return raced ? update(raced.id) : { error: error.message };
      },
    }),
    memory_read: tool({
      description: '依名稱讀取記憶的完整內容（索引只有名稱和說明）。同名的私有與專案記憶都會回傳。',
      inputSchema: z.object({ names: z.array(z.string().trim().min(1)).min(1).max(10) }),
      execute: async ({ names }) => {
        const { data, error } = await db
          .from('memories')
          .select('instance_id, name, description, type, content')
          .eq('project_id', projectId)
          .or(visibleTo(instanceId))
          .in('name', names);
        if (error) return { error: error.message };
        return {
          memories: data.map((m) => ({ name: m.name, scope: scopeOf(m), type: m.type, description: m.description, content: m.content })),
          missing: names.filter((n) => !data.some((m) => m.name === n)),
        };
      },
    }),
    memory_delete: tool({
      description: '刪除一筆記憶。發現記憶錯了或過時、又不適合更新時使用。',
      inputSchema: z.object({ name: z.string().trim().min(1), scope: scopeField }),
      execute: async ({ name, scope }) => {
        const { data: existing, error: findError } = await inScope(scope, name).maybeSingle();
        if (findError) return { error: findError.message };
        if (!existing) return { error: `找不到${SCOPE_LABEL[scope]}記憶「${name}」` };
        const { error } = await db.from('memories').delete().eq('id', existing.id);
        return error ? { error: error.message } : { ok: true };
      },
    }),
  };
}
