import { HttpError } from '@/lib/http';
import type { SkillMeta } from '@/lib/skills-zip';
import type { Db } from '@/lib/supabase/admin';

export type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  sprite_name: string | null;
  sprite_url: string | null;
  sprite_status: 'provisioning' | 'ready' | 'error';
  sprite_error: string | null;
  created_at: string;
};

export type AgentSummary = {
  id: string;
  name: string;
  description: string;
  role: 'consultant' | 'manager';
  template_id: string | null;
  skills: SkillMeta[];
  mcp_names: string[];
};

export type ThreadRow = { id: string; project_id: string; title: string; created_at: string };

export type ProjectDetail = { project: ProjectRow; agents: AgentSummary[]; threads: ThreadRow[] };

const COLUMNS = 'id, owner_id, name, sprite_name, sprite_url, sprite_status, sprite_error, created_at';

export async function listProjects(db: Db, userId: string): Promise<ProjectRow[]> {
  const { data, error } = await db.from('projects').select(COLUMNS).eq('owner_id', userId).order('created_at', { ascending: false });
  if (error) throw error;
  return data as ProjectRow[];
}

export async function createProject(db: Db, userId: string, name: string): Promise<ProjectRow> {
  const { data, error } = await db.from('projects').insert({ owner_id: userId, name }).select(COLUMNS).single();
  if (error) throw error;
  return data as ProjectRow;
}

export async function getOwnProject(db: Db, userId: string, id: string): Promise<ProjectRow> {
  const { data, error } = await db.from('projects').select(COLUMNS).eq('id', id).eq('owner_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, '找不到這個專案');
  return data as ProjectRow;
}

export async function getProjectDetail(db: Db, userId: string, id: string): Promise<ProjectDetail> {
  const project = await getOwnProject(db, userId, id);
  const [agentsResult, threadsResult] = await Promise.all([
    db.from('agent_instances').select('id, name, description, role, template_id, skills, mcp_servers').eq('project_id', id).order('created_at'),
    db.from('threads').select('id, project_id, title, created_at').eq('project_id', id).order('created_at', { ascending: false }),
  ]);
  if (agentsResult.error) throw agentsResult.error;
  if (threadsResult.error) throw threadsResult.error;
  const agents = agentsResult.data
    .map(({ mcp_servers, ...a }) => ({ ...a, mcp_names: (mcp_servers as { name: string }[]).map((s) => s.name) }) as AgentSummary)
    .sort((a, b) => Number(a.role === 'manager') - Number(b.role === 'manager'));
  return { project, agents, threads: threadsResult.data as ThreadRow[] };
}

export async function setSpriteState(
  db: Db,
  id: string,
  patch: Partial<Pick<ProjectRow, 'sprite_name' | 'sprite_url' | 'sprite_status' | 'sprite_error'>>,
): Promise<void> {
  const { error } = await db.from('projects').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteOwnProject(db: Db, userId: string, id: string): Promise<ProjectRow> {
  const project = await getOwnProject(db, userId, id);
  const { error } = await db.from('projects').delete().eq('id', id);
  if (error) throw error;
  return project;
}

export async function hireAgent(
  db: Db,
  userId: string,
  projectId: string,
  templateId: string,
  secrets: Record<string, Record<string, string>>,
): Promise<string> {
  await getOwnProject(db, userId, projectId);
  const { data, error } = await db.rpc('hire_agent', { p_project_id: projectId, p_template_id: templateId, p_secrets: secrets });
  if (error) {
    if (error.code === '22023') throw new HttpError(400, `請填寫金鑰：${error.message.replace('missing secret ', '')}`);
    if (error.code === 'P0002') throw new HttpError(404, '這個 agent 尚未上架');
    throw error;
  }
  return data as string;
}
