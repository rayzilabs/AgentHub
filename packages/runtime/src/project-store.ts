import type { Db } from './db';
import type { AgentInstance, SecretRow } from './types';

export async function loadInstances(db: Db, projectId: string): Promise<AgentInstance[]> {
  const { data, error } = await db
    .from('agent_instances')
    .select('id, project_id, template_id, role, name, description, system_prompt, skills_zip_path, skills, mcp_servers, template:agent_templates(creator_id)')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(({ template, ...row }) => ({
    ...row,
    creator_id: (template as unknown as { creator_id: string } | null)?.creator_id ?? null,
  })) as AgentInstance[];
}

export async function loadSecrets(db: Db, projectId: string): Promise<SecretRow[]> {
  const { data, error } = await db.rpc('get_project_secrets', { p_project_id: projectId });
  if (error) throw error;
  return data as SecretRow[];
}

export function groupSecrets(rows: SecretRow[], instanceId: string): Record<string, Record<string, string>> {
  const grouped: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    if (row.instance_id !== instanceId) continue;
    grouped[row.mcp_name] ??= {};
    grouped[row.mcp_name][row.key] = row.value;
  }
  return grouped;
}
