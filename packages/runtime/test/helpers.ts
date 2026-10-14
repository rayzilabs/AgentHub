import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { inject } from 'vitest';
import type { Config } from '../src/config';
import { createDb, createUserDb, type Db } from '../src/db';
import type { McpServerConfig, SkillMeta } from '../src/types';

export function testDb(): Db {
  return createDb(inject('supabaseUrl'), inject('supabaseServiceKey'));
}

export async function seedUser(db: Db): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email: `u-${randomUUID()}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error) throw error;
  return data.user.id;
}

export async function seedTemplate(db: Db, creatorId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await db
    .from('agent_templates')
    .insert({ creator_id: creatorId, name: '測試範本', status: 'published', ...fields })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function seedProject(db: Db, ownerId: string): Promise<string> {
  const { data, error } = await db.from('projects').insert({ owner_id: ownerId, name: '測試專案' }).select('id').single();
  if (error) throw error;
  return data.id;
}

export async function seedThread(db: Db, projectId: string): Promise<string> {
  const { data, error } = await db.from('threads').insert({ project_id: projectId }).select('id').single();
  if (error) throw error;
  return data.id;
}

export type ConsultantFields = {
  template_id?: string | null;
  name?: string;
  description?: string;
  system_prompt?: string;
  skills_zip_path?: string | null;
  skills?: SkillMeta[];
  mcp_servers?: McpServerConfig[];
};

export async function seedConsultant(db: Db, projectId: string, fields: ConsultantFields = {}): Promise<string> {
  const { data, error } = await db
    .from('agent_instances')
    .insert({
      project_id: projectId, role: 'consultant', name: '法務顧問', description: '處理法律問題',
      system_prompt: '你是法務顧問。', ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function seedManager(db: Db, projectId: string): Promise<string> {
  const { data, error } = await db
    .from('agent_instances')
    .insert({ project_id: projectId, role: 'manager', name: '主管', description: '平台內建主管' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function uploadSkillsZip(db: Db, files: Record<string, string>): Promise<string> {
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
  const sha = createHash('sha256').update(zip).digest('hex');
  const objectPath = `${randomUUID()}/${sha}.zip`;
  const { error } = await db.storage.from('skills').upload(objectPath, zip, { contentType: 'application/zip' });
  if (error) throw error;
  return objectPath;
}

export type Roots = { agentsRoot: string; sharedRoot: string; sock: string };

export async function tmpRoots(): Promise<Roots> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agenthub-'));
  return {
    agentsRoot: path.join(base, 'agents'),
    sharedRoot: path.join(base, 'shared'),
    sock: path.join(base, 'missing.sock'),
  };
}

export function testConfig(projectId: string, roots: Roots): Config {
  return {
    PROJECT_ID: projectId,
    SUPABASE_URL: inject('supabaseUrl'),
    SUPABASE_PUBLISHABLE_KEY: 'test',
    PLATFORM_URL: 'https://p.test',
    AGENTS_ROOT: roots.agentsRoot,
    SHARED_ROOT: roots.sharedRoot,
    SPRITE_API_SOCK: roots.sock,
    MODEL_ID: 'mock',
    PORT: 0,
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 測試用：建立專案的 runtime 帳號並登入，回傳通行證（正式環境由 Vercel 的 lib/runtime-session 處理） */
export async function runtimeToken(db: Db, projectId: string): Promise<string> {
  const email = `runtime-${projectId}@runtime.agenthub.internal`;
  const password = randomUUID();
  const { error } = await db.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { agenthub_runtime_project: projectId },
  });
  if (error) throw error;
  const auth = createDb(inject('supabaseUrl'), inject('supabasePublishableKey'));
  const { data, error: signInError } = await auth.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return data.session!.access_token;
}

/** 以 runtime 帳號通行證連線（與 Sprite 上的 runtime 相同） */
export function runtimeDb(token: string): Db {
  return createUserDb(inject('supabaseUrl'), inject('supabasePublishableKey'), token);
}
