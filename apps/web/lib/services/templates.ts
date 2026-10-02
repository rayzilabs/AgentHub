import { createHash } from 'node:crypto';
import { HttpError } from '@/lib/http';
import type { McpServer, TemplateInput, TemplatePatch } from '@/lib/schemas';
import { parseSkillsZip, SkillZipError, type SkillMeta } from '@/lib/skills-zip';
import type { Db } from '@/lib/supabase/admin';

export type TemplateRow = {
  id: string;
  creator_id: string;
  name: string;
  description: string;
  category: string;
  system_prompt: string;
  skills_zip_path: string | null;
  skills: SkillMeta[];
  mcp_servers: McpServer[];
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
};

export type PublishedTemplate = TemplateRow & { creator_name: string };

const COLUMNS = 'id, creator_id, name, description, category, system_prompt, skills_zip_path, skills, mcp_servers, status, created_at, updated_at';
const WITH_CREATOR = `${COLUMNS}, creator:profiles(display_name)`;
const NOT_FOUND = '找不到這個 agent';

function withCreatorName(row: Record<string, unknown>): PublishedTemplate {
  const { creator, ...rest } = row;
  return { ...(rest as TemplateRow), creator_name: (creator as { display_name: string } | null)?.display_name ?? '' };
}

export async function listPublishedTemplates(db: Db): Promise<PublishedTemplate[]> {
  const { data, error } = await db.from('agent_templates').select(WITH_CREATOR).eq('status', 'published').order('updated_at', { ascending: false });
  if (error) throw error;
  return data.map(withCreatorName);
}

export async function listMyTemplates(db: Db, userId: string): Promise<TemplateRow[]> {
  const { data, error } = await db.from('agent_templates').select(COLUMNS).eq('creator_id', userId).order('updated_at', { ascending: false });
  if (error) throw error;
  return data as TemplateRow[];
}

export async function getTemplate(db: Db, id: string, viewerId: string | null): Promise<PublishedTemplate> {
  const { data, error } = await db.from('agent_templates').select(WITH_CREATOR).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, NOT_FOUND);
  const row = withCreatorName(data);
  if (row.status !== 'published' && row.creator_id !== viewerId) throw new HttpError(404, NOT_FOUND);
  return row;
}

async function getOwnTemplate(db: Db, userId: string, id: string): Promise<TemplateRow> {
  const { data, error } = await db.from('agent_templates').select(COLUMNS).eq('id', id).eq('creator_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, NOT_FOUND);
  return data as TemplateRow;
}

export async function createTemplate(db: Db, userId: string, input: TemplateInput): Promise<TemplateRow> {
  const { data, error } = await db.from('agent_templates').insert({ ...input, creator_id: userId }).select(COLUMNS).single();
  if (error) throw error;
  return data as TemplateRow;
}

export async function createSkillsUploadUrl(db: Db, userId: string, id: string): Promise<{ signedUrl: string; path: string }> {
  await getOwnTemplate(db, userId, id);
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

  const sha = createHash('sha256').update(bytes).digest('hex');
  const finalPath = `${id}/${sha}.zip`;
  const { error: uploadError } = await bucket.upload(finalPath, bytes, { contentType: 'application/zip', upsert: true });
  if (uploadError) throw uploadError;
  await bucket.remove([uploadPath]);
  return { skills_zip_path: finalPath, skills };
}

export async function updateTemplate(db: Db, userId: string, id: string, patch: TemplatePatch): Promise<TemplateRow> {
  await getOwnTemplate(db, userId, id);
  const { process_upload, ...fields } = patch;
  const changes: Record<string, unknown> = { ...fields, updated_at: new Date().toISOString() };
  if (process_upload) Object.assign(changes, await processSkillsUpload(db, id));
  const { data, error } = await db.from('agent_templates').update(changes).eq('id', id).select(COLUMNS).single();
  if (error) throw error;
  return data as TemplateRow;
}

export async function publishTemplate(db: Db, userId: string, id: string): Promise<TemplateRow> {
  const template = await getOwnTemplate(db, userId, id);
  if (!template.system_prompt.trim()) throw new HttpError(400, '請先填寫 system prompt');
  const { data, error } = await db
    .from('agent_templates')
    .update({ status: 'published', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as TemplateRow;
}
