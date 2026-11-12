import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { TemplateInputSchema, type TemplateInput } from '@/lib/schemas';
import { createSkillsUploadUrl, createTemplate, listMyTemplates, publishTemplate, updateTemplate } from '@/lib/services/templates';
import type { Db } from '@/lib/supabase/admin';

export type DemoAgent = { slug: string; input: TemplateInput; skillsZip: Uint8Array };

const DEFAULT_ROOT = fileURLToPath(new URL('../demo/agents', import.meta.url));
export const BUSINESS_AGENTS_ROOT = fileURLToPath(new URL('../demo/business-agents', import.meta.url));

async function collect(dir: string, prefix = ''): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await collect(full, rel));
    else out[rel] = new Uint8Array(await readFile(full));
  }
  return out;
}

export async function loadDemoAgents(root = DEFAULT_ROOT): Promise<DemoAgent[]> {
  const slugs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return Promise.all(
    slugs.map(async (slug) => {
      const dir = path.join(root, slug);
      const input = TemplateInputSchema.parse(JSON.parse(await readFile(path.join(dir, 'agent.json'), 'utf8')));
      const skillsZip = zipSync(await collect(path.join(dir, 'skills')));
      return { slug, input, skillsZip };
    }),
  );
}

/** 以創作者身分建立或更新（依名稱比對）範本、上傳 skill zip 並上架。 */
export async function publishDemoAgents(db: Db, creatorId: string, agents: DemoAgent[]): Promise<{ id: string; name: string; created: boolean }[]> {
  const existing = await listMyTemplates(db, creatorId);
  const results = [];
  for (const agent of agents) {
    const current = existing.find((t) => t.name === agent.input.name);
    const t = current ?? (await createTemplate(db, creatorId, agent.input));
    const { signedUrl } = await createSkillsUploadUrl(db, creatorId, t.id);
    const put = await fetch(signedUrl, { method: 'PUT', body: new Blob([new Uint8Array(agent.skillsZip)], { type: 'application/zip' }), headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
    if (!put.ok) throw new Error(`上傳 ${agent.slug} 的 skill 失敗（HTTP ${put.status}），請稍後重跑。`);
    await updateTemplate(db, creatorId, t.id, { ...agent.input, process_upload: true });
    await publishTemplate(db, creatorId, t.id);
    results.push({ id: t.id, name: agent.input.name, created: !current });
  }
  return results;
}
