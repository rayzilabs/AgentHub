import { HttpError } from '@/lib/http';
import type { Db } from '@/lib/supabase/admin';

export type RemoteTarget = { url: string; templateId: string | null; creatorId: string | null };

/** 找出顧問鎖定的創作者 MCP 網址；顧問不存在、不屬於這個專案或沒有這個 MCP 時拒絕 */
export async function resolveRemoteTarget(db: Db, instanceId: string, mcpName: string, projectId: string): Promise<RemoteTarget> {
  const { data: inst, error } = await db
    .from('agent_instances')
    .select('project_id, role, template_id, template:agent_templates(creator_id)')
    .eq('id', instanceId)
    .maybeSingle();
  if (error) throw error;
  if (!inst || inst.role !== 'consultant') throw new HttpError(404, '找不到這位顧問');
  if (inst.project_id !== projectId) throw new HttpError(403, '這位顧問不屬於這個專案');
  const { data: target, error: targetError } = await db
    .from('remote_mcp_targets')
    .select('kind, url')
    .eq('instance_id', instanceId)
    .eq('mcp_name', mcpName)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target || target.kind !== 'self' || !target.url) throw new HttpError(404, '找不到這個工具服務');
  const template = inst.template as { creator_id?: string } | null;
  return { url: target.url, templateId: inst.template_id, creatorId: template?.creator_id ?? null };
}

/** JSON-RPC 本文是 tools/call 時回傳工具名稱（批次取第一個），其餘回傳 null */
export function toolCallName(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const call = list.find((m) => (m as { method?: unknown } | null)?.method === 'tools/call') as
      | { params?: { name?: unknown } }
      | undefined;
    return typeof call?.params?.name === 'string' ? call.params.name : null;
  } catch {
    return null;
  }
}

export type UsageRow = {
  project_id: string;
  instance_id: string;
  template_id: string | null;
  creator_id: string | null;
  mcp_name: string;
  tool: string;
  ok: boolean;
  duration_ms: number;
};

export async function recordUsage(db: Db, row: UsageRow): Promise<void> {
  const { error } = await db.from('mcp_usage').insert(row);
  if (error) throw error;
}
