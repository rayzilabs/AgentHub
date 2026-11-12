import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { HttpError } from '@/lib/http';
import { requirementsProblems } from '@/lib/requirements';
import type { McpServer, TemplateInput, TemplatePatch } from '@/lib/schemas';
import { parseSkillsZip, SkillZipError, type SkillMeta } from '@/lib/skills-zip';
import type { Db } from '@/lib/supabase/admin';
import { getMembership, requireAdmin, requireMember, type OrgRole } from './orgs';

export type TemplateRow = {
  id: string;
  creator_id: string;
  /** null 是公開市集的範本；有值時只屬於這個組織 */
  org_id: string | null;
  name: string;
  description: string;
  category: string;
  system_prompt: string;
  skills_zip_path: string | null;
  skills: SkillMeta[];
  mcp_servers: McpServer[];
  status: 'draft' | 'pending' | 'published';
  created_at: string;
  updated_at: string;
};

/** 能編輯的人看到的完整資料（含 system prompt、skill 檔路徑、MCP 連線設定）。 */
export type PublishedTemplate = TemplateRow & { creator_name: string; org_name: string | null };

/** 市集與非擁有者看到的 MCP：只有名稱、連線方式與需要的金鑰，不含指令、網址、headers。 */
export type PublicMcpServer = Pick<McpServer, 'name' | 'transport' | 'required_secrets'>;

/** 市集與非擁有者看到的資料：不含創作者的 system prompt、skill 檔路徑與 MCP 連線設定。 */
export type PublicTemplate = Omit<TemplateRow, 'system_prompt' | 'skills_zip_path' | 'mcp_servers'> & {
  mcp_servers: PublicMcpServer[];
  creator_name: string;
  org_name: string | null;
};

const COLUMNS = 'id, creator_id, org_id, name, description, category, system_prompt, skills_zip_path, skills, mcp_servers, status, created_at, updated_at';
const PUBLIC_COLUMNS = 'id, creator_id, org_id, name, description, category, skills, mcp_servers, status, created_at, updated_at';
const NAMES = 'creator:profiles(display_name), org:organizations(name)';
const WITH_NAMES = `${COLUMNS}, ${NAMES}`;
const PUBLIC_WITH_NAMES = `${PUBLIC_COLUMNS}, ${NAMES}`;
const NOT_FOUND = '找不到這個 agent';
const NOT_PENDING = '這個顧問不在待核准狀態，請重新整理';

function withNames(row: Record<string, unknown>): PublishedTemplate {
  const { creator, org, ...rest } = row;
  return {
    ...(rest as TemplateRow),
    creator_name: (creator as { display_name: string } | null)?.display_name ?? '',
    org_name: (org as { name: string } | null)?.name ?? null,
  };
}

function toPublic(row: Omit<PublishedTemplate, 'system_prompt' | 'skills_zip_path'>): PublicTemplate {
  const { id, creator_id, org_id, name, description, category, skills, mcp_servers, status, created_at, updated_at, creator_name, org_name } = row;
  return {
    id, creator_id, org_id, name, description, category, skills, status, created_at, updated_at, creator_name, org_name,
    mcp_servers: mcp_servers.map((s) => ({ name: s.name, transport: s.transport, required_secrets: s.required_secrets ?? [] })),
  };
}

/** 公開範本：建立者本人。組織範本：建立者仍是成員，或該組織管理員（role 是 userId 在該組織的身分）。 */
function canEdit(t: Pick<TemplateRow, 'creator_id' | 'org_id'>, userId: string | null, role: OrgRole | null): boolean {
  if (!t.org_id) return t.creator_id === userId;
  return role === 'admin' || (role === 'member' && t.creator_id === userId);
}

export async function listPublishedTemplates(db: Db): Promise<PublicTemplate[]> {
  const { data, error } = await db.from('agent_templates').select(PUBLIC_WITH_NAMES)
    .eq('status', 'published').is('org_id', null).order('updated_at', { ascending: false });
  if (error) throw error;
  return data.map((row) => toPublic(withNames(row)));
}

/** 一般成員只看得到已上架的；管理員看得到全部狀態（含待核准）。 */
export async function listOrgTemplates(db: Db, userId: string, orgId: string): Promise<(PublicTemplate & { editable: boolean })[]> {
  const role = await requireMember(db, userId, orgId);
  let query = db.from('agent_templates').select(PUBLIC_WITH_NAMES).eq('org_id', orgId);
  if (role !== 'admin') query = query.eq('status', 'published');
  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) throw error;
  return data.map((row) => {
    const t = toPublic(withNames(row));
    return { ...t, editable: canEdit(t, userId, role) };
  });
}

/** 自己建的範本；組織範本在自己離開組織後就不再列出（只剩管理員能維護）。 */
export async function listMyTemplates(db: Db, userId: string): Promise<TemplateRow[]> {
  const [{ data, error }, { data: memberships, error: memberError }] = await Promise.all([
    db.from('agent_templates').select(COLUMNS).eq('creator_id', userId).order('updated_at', { ascending: false }),
    db.from('org_members').select('org_id').eq('user_id', userId),
  ]);
  if (error) throw error;
  if (memberError) throw memberError;
  const myOrgs = new Set(memberships.map((m) => m.org_id as string));
  return (data as TemplateRow[]).filter((t) => !t.org_id || myOrgs.has(t.org_id));
}

/**
 * 能編輯的人拿到完整資料；其他人（含未登入）只拿到公開欄位，且只看得到已上架的。
 * 組織範本只有該組織成員看得到。
 */
export async function getTemplate(db: Db, id: string, viewerId: string | null): Promise<PublishedTemplate | PublicTemplate> {
  const { data, error } = await db.from('agent_templates').select(WITH_NAMES).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, NOT_FOUND);
  const row = withNames(data);
  let role: OrgRole | null = null;
  if (row.org_id) {
    role = viewerId ? await getMembership(db, viewerId, row.org_id) : null;
    if (!role) throw new HttpError(404, NOT_FOUND);
  }
  if (canEdit(row, viewerId, role)) return row;
  if (row.status !== 'published') throw new HttpError(404, NOT_FOUND);
  return toPublic(row);
}

export async function getEditableTemplate(db: Db, userId: string, id: string): Promise<TemplateRow> {
  const { data, error } = await db.from('agent_templates').select(COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, NOT_FOUND);
  const template = data as TemplateRow;
  const role = template.org_id ? await getMembership(db, userId, template.org_id) : null;
  if (!canEdit(template, userId, role)) throw new HttpError(404, NOT_FOUND);
  return template;
}

export async function createTemplate(db: Db, userId: string, input: TemplateInput): Promise<TemplateRow> {
  if (input.org_id) await requireMember(db, userId, input.org_id);
  const { data, error } = await db.from('agent_templates').insert({ ...input, creator_id: userId }).select(COLUMNS).single();
  if (error) throw error;
  return data as TemplateRow;
}

export async function createSkillsUploadUrl(db: Db, userId: string, id: string): Promise<{ signedUrl: string; path: string }> {
  await getEditableTemplate(db, userId, id);
  const path = `${id}/upload.zip`;
  const { data, error } = await db.storage.from('skills').createSignedUploadUrl(path, { upsert: true });
  if (error) throw error;
  return { signedUrl: data.signedUrl, path };
}

async function processSkillsUpload(db: Db, id: string): Promise<{ skills_zip_path: string; skills: SkillMeta[] }> {
  const bucket = db.storage.from('skills');
  const uploadPath = `${id}/upload.zip`;
  const { data: blob, error } = await bucket.download(uploadPath);
  if (error || !blob) throw new HttpError(400, '還沒有上傳 skill 檔案');
  const bytes = new Uint8Array(await blob.arrayBuffer());

  let skills: SkillMeta[];
  try {
    skills = parseSkillsZip(bytes);
  } catch (e) {
    if (e instanceof SkillZipError) throw new HttpError(400, e.problems.join('\n'));
    throw e;
  }
  // skill 的 requirements.txt：格式與 PyPI 上是否存在，有問題就不收（runtime 會依它安裝顧問的套件）
  const requirementProblems = await requirementsProblems(unzipSync(bytes), skills);
  if (requirementProblems.length) throw new HttpError(400, requirementProblems.join('\n'));

  const sha = createHash('sha256').update(bytes).digest('hex');
  const finalPath = `${id}/${sha}.zip`;
  const { error: uploadError } = await bucket.upload(finalPath, bytes, { contentType: 'application/zip', upsert: true });
  if (uploadError) throw uploadError;
  await bucket.remove([uploadPath]);
  return { skills_zip_path: finalPath, skills };
}

/** 平台代管 MCP 已發布的版本數 */
export async function publishedVersionCount(db: Db, templateId: string, mcpName: string): Promise<number> {
  const { count, error } = await db.from('hosted_mcp_versions').select('id', { count: 'exact', head: true })
    .eq('template_id', templateId).eq('mcp_name', mcpName).eq('status', 'published');
  if (error) throw error;
  return count ?? 0;
}

const isHosted = (s: McpServer) => s.transport === 'remote' && s.hosted === true;

/** 上架中的範本，每個平台代管 MCP 都要有已發布的版本（否則市集上看得到、卻租用不了） */
async function assertHostedPublished(db: Db, id: string, servers: McpServer[]): Promise<void> {
  for (const s of servers.filter(isHosted)) {
    if (!(await publishedVersionCount(db, id, s.name))) throw new HttpError(400, `MCP「${s.name}」還沒有已發布的版本`);
  }
}

/** 改名、移除或改連線方式會讓既有版本、金鑰與 Sprite 在頁面上消失（仍佔名額）；要先下架所有版本 */
async function assertNoOrphanedVersions(db: Db, id: string, saved: McpServer[], next: McpServer[]): Promise<void> {
  const kept = new Set(next.filter(isHosted).map((s) => s.name));
  for (const s of saved.filter(isHosted)) {
    if (kept.has(s.name)) continue;
    const { count, error } = await db.from('hosted_mcp_versions').select('id', { count: 'exact', head: true })
      .eq('template_id', id).eq('mcp_name', s.name).neq('status', 'retired');
    if (error) throw error;
    if (count) throw new HttpError(400, `MCP「${s.name}」還有未下架的版本，請先在代管區塊下架所有版本，再改名、移除或改連線方式`);
  }
}

export async function updateTemplate(db: Db, userId: string, id: string, patch: TemplatePatch): Promise<TemplateRow> {
  const template = await getEditableTemplate(db, userId, id);
  if (patch.mcp_servers) {
    await assertNoOrphanedVersions(db, id, template.mcp_servers, patch.mcp_servers);
    // 已上架：原本就在的代管 MCP 要保有已發布版本。新加的代管 MCP 要先存檔才能建立版本，
    // 所以不擋；第一個版本發布前，新的租用會回 409（頁面會提示）
    const existing = new Set(template.mcp_servers.filter(isHosted).map((s) => s.name));
    if (template.status === 'published') await assertHostedPublished(db, id, patch.mcp_servers.filter((s) => existing.has(s.name)));
  }
  const { process_upload, ...fields } = patch;
  const changes: Record<string, unknown> = { ...fields, updated_at: new Date().toISOString() };
  if (process_upload) Object.assign(changes, await processSkillsUpload(db, id));
  const { data, error } = await db.from('agent_templates').update(changes).eq('id', id).select(COLUMNS).single();
  if (error) throw error;
  return data as TemplateRow;
}

async function assertPublishable(db: Db, template: TemplateRow): Promise<void> {
  if (!template.system_prompt.trim()) throw new HttpError(400, '請先填寫 system prompt');
  await assertHostedPublished(db, template.id, template.mcp_servers);
}

async function setStatus(db: Db, id: string, status: TemplateRow['status']): Promise<TemplateRow> {
  const { data, error } = await db.from('agent_templates').update({ status, updated_at: new Date().toISOString() })
    .eq('id', id).select(COLUMNS).single();
  if (error) throw error;
  return data as TemplateRow;
}

/** 組織要求核准時，一般成員還沒上架的顧問先進待核准；已上架的再按一次仍是原地更新。 */
async function needsApproval(db: Db, userId: string, template: TemplateRow): Promise<boolean> {
  if (!template.org_id || template.status === 'published') return false;
  const [{ data: org, error }, role] = await Promise.all([
    db.from('organizations').select('require_template_approval').eq('id', template.org_id).single(),
    getMembership(db, userId, template.org_id),
  ]);
  if (error) throw error;
  return org.require_template_approval && role !== 'admin';
}

export async function publishTemplate(db: Db, userId: string, id: string): Promise<TemplateRow> {
  const template = await getEditableTemplate(db, userId, id);
  await assertPublishable(db, template);
  return setStatus(db, id, (await needsApproval(db, userId, template)) ? 'pending' : 'published');
}

export async function reviewTemplate(db: Db, userId: string, id: string, action: 'approve' | 'reject'): Promise<TemplateRow> {
  const { data, error } = await db.from('agent_templates').select(COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  const template = data as TemplateRow | null;
  // 組織外的人一律當作不存在，不透露這是哪個組織的範本
  if (!template?.org_id || !(await getMembership(db, userId, template.org_id))) throw new HttpError(404, NOT_FOUND);
  await requireAdmin(db, userId, template.org_id);
  if (template.status !== 'pending') throw new HttpError(409, NOT_PENDING);
  // 待核准期間內容可能被改過，核准時再檢查一次上架條件
  if (action === 'approve') await assertPublishable(db, template);
  const { data: updated, error: updateError } = await db.from('agent_templates')
    .update({ status: action === 'approve' ? 'published' : 'draft', updated_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'pending').select(COLUMNS).maybeSingle();
  if (updateError) throw updateError;
  if (!updated) throw new HttpError(409, NOT_PENDING);
  return updated as TemplateRow;
}

/** 下架＝退回草稿；已租進專案的副本由執行時的檢查擋下。 */
export async function unpublishTemplate(db: Db, userId: string, id: string): Promise<TemplateRow> {
  const template = await getEditableTemplate(db, userId, id);
  if (!template.org_id) throw new HttpError(400, '公開市集的顧問目前不能下架');
  return setStatus(db, id, 'draft');
}
