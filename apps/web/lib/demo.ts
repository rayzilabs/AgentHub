import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { RETIRABLE } from '@/lib/hosted-ui';
import { createHostedSpriteOps } from '@/lib/hosted-sprite';
import { HttpError } from '@/lib/http';
import { TemplateInputSchema, type TemplateInput } from '@/lib/schemas';
import {
  createVersion, HOSTED_BUCKET, listVersions, publishVersion, retireVersion, startDeploy, syncVersion, type HostedSpriteOps,
} from '@/lib/services/hosted-mcp';
import { createSkillsUploadUrl, createTemplate, listMyTemplates, publishTemplate, updateTemplate } from '@/lib/services/templates';
import type { Db } from '@/lib/supabase/admin';

type Files = Record<string, Uint8Array>;
/** hosted：agent.json 裡每個平台代管 MCP 的套件檔案（名稱 → 檔案） */
export type DemoAgent = { slug: string; input: TemplateInput; skillsZip: Uint8Array; hosted: Record<string, Files> };

const DEFAULT_ROOT = fileURLToPath(new URL('../demo/agents', import.meta.url));
export const BUSINESS_AGENTS_ROOT = fileURLToPath(new URL('../demo/business-agents', import.meta.url));
/** 代管 MCP 套件，依 MCP 名稱放在 hosted-mcp/<名稱>/，可由多位顧問共用 */
export const HOSTED_MCP_ROOT = fileURLToPath(new URL('../demo/hosted-mcp', import.meta.url));

// 本機跑過測試或安裝會產生的檔案；打包與比對內容都略過，免得內容沒變也被當成新版本
const SKIP_DIRS = new Set(['__pycache__', 'node_modules']);
const skip = (name: string, isDir: boolean) => name.startsWith('.') || (isDir ? SKIP_DIRS.has(name) : name.endsWith('.pyc'));

async function collect(dir: string, prefix = ''): Promise<Files> {
  const out: Files = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip(entry.name, entry.isDirectory())) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await collect(full, rel));
    else out[rel] = new Uint8Array(await readFile(full));
  }
  return out;
}

async function collectHosted(hostedRoot: string, name: string): Promise<Files> {
  const dir = path.join(hostedRoot, name);
  try {
    return await collect(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`找不到代管 MCP「${name}」的套件：${dir}，請把套件放在這個資料夾。`);
    throw e;
  }
}

export async function loadDemoAgents(root = DEFAULT_ROOT, hostedRoot = HOSTED_MCP_ROOT): Promise<DemoAgent[]> {
  const slugs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return Promise.all(
    slugs.map(async (slug) => {
      const dir = path.join(root, slug);
      const input = TemplateInputSchema.parse(JSON.parse(await readFile(path.join(dir, 'agent.json'), 'utf8')));
      const skillsZip = zipSync(await collect(path.join(dir, 'skills')));
      const hosted: Record<string, Files> = {};
      for (const s of input.mcp_servers.filter((m) => m.hosted)) hosted[s.name] = await collectHosted(hostedRoot, s.name);
      return { slug, input, skillsZip, hosted };
    }),
  );
}

/** zip 每次打包的位元組不同（含時間），所以比對檔案內容 */
function contentHash(files: Files): string {
  const h = createHash('sha256');
  for (const rel of Object.keys(files).sort()) h.update(`${rel}\0${createHash('sha256').update(files[rel]).digest('hex')}\n`);
  return h.digest('hex');
}

async function putZip(signedUrl: string, bytes: Uint8Array, what: string): Promise<void> {
  const res = await fetch(signedUrl, { method: 'PUT', body: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
  if (!res.ok) throw new Error(`上傳${what}失敗（HTTP ${res.status}），請稍後重跑。`);
}

async function storedHash(db: Db, bundlePath: string): Promise<string> {
  const { data, error } = await db.storage.from(HOSTED_BUCKET).download(bundlePath);
  if (error) throw error;
  return contentHash(unzipSync(new Uint8Array(await data.arrayBuffer())));
}

/** 內容與最新已發布版本相同就不動（每個版本是一台機器）；否則部署新版本、發布，再下架沒有專案在用的舊版本。回傳是否部署了新版本 */
async function deployHosted(db: Db, creatorId: string, templateId: string, name: string, files: Files, sprites: HostedSpriteOps): Promise<boolean> {
  const versions = await listVersions(db, creatorId, templateId, name);
  const latest = versions.find((v) => v.status === 'published');
  if (latest && (await storedHash(db, latest.bundle_path)) === contentHash(files)) return false;

  const { version, signedUrl } = await createVersion(db, creatorId, templateId, name);
  await putZip(signedUrl, zipSync(files), `代管 MCP「${name}」的套件`);
  await startDeploy(db, creatorId, version.id);
  // 部署靠讀取推進；超過 10 分鐘 syncVersion 會自己標成失敗
  let current = await syncVersion(db, version.id, sprites);
  while (current.status === 'deploying') {
    await new Promise((r) => setTimeout(r, 5000));
    current = await syncVersion(db, version.id, sprites);
  }
  if (current.status !== 'ready') throw new Error(`代管 MCP「${name}」部署失敗：\n${current.log_tail}`);
  await publishVersion(db, creatorId, version.id);

  for (const old of versions) {
    if (old.projects > 0 || !RETIRABLE.includes(old.status)) continue;
    // 狀態可能剛好被別人改了或有專案剛租用，跳過即可，下次重跑再清
    await retireVersion(db, creatorId, old.id, sprites).catch((e) => { if (!(e instanceof HttpError && e.status === 409)) throw e; });
  }
  return true;
}

/** 以創作者身分建立或更新（依名稱比對）範本、上傳 skill zip、部署代管 MCP，再上架。 */
export async function publishDemoAgents(
  db: Db, creatorId: string, agents: DemoAgent[], sprites: HostedSpriteOps = createHostedSpriteOps(),
): Promise<{ id: string; name: string; created: boolean; deployed: string[] }[]> {
  const existing = await listMyTemplates(db, creatorId);
  const results = [];
  for (const agent of agents) {
    const current = existing.find((t) => t.name === agent.input.name);
    const t = current ?? (await createTemplate(db, creatorId, agent.input));
    const { signedUrl } = await createSkillsUploadUrl(db, creatorId, t.id);
    await putZip(signedUrl, agent.skillsZip, ` ${agent.slug} 的 skill`);
    await updateTemplate(db, creatorId, t.id, { ...agent.input, process_upload: true });
    const deployed: string[] = [];
    for (const [name, files] of Object.entries(agent.hosted)) {
      if (await deployHosted(db, creatorId, t.id, name, files, sprites)) deployed.push(name);
    }
    await publishTemplate(db, creatorId, t.id);
    results.push({ id: t.id, name: agent.input.name, created: !current, deployed });
  }
  return results;
}
