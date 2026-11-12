import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { canRetire, POLL_MS } from '@/lib/hosted-ui';
import { HttpError } from '@/lib/http';
import { TemplateInputSchema, type TemplateInput } from '@/lib/schemas';
import { HOSTED_BUCKET, type HostedVersion, type HostedVersionView } from '@/lib/services/hosted-mcp';
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

/**
 * 代管 MCP 的版本操作。部署檢查要用平台私鑰簽通行證，私鑰只在正式站，
 * 所以上架腳本用 apiHostedClient 以創作者身分呼叫正式站 API（docs/creator/hosted-mcp.md 附錄）。
 */
export type HostedClient = {
  list(templateId: string, mcp: string): Promise<HostedVersionView[]>;
  create(templateId: string, mcp: string): Promise<{ version: HostedVersion; signedUrl: string }>;
  deploy(templateId: string, mcp: string, versionId: string): Promise<HostedVersion>;
  /** 讀取部署中的版本會推進部署 */
  get(templateId: string, mcp: string, versionId: string): Promise<HostedVersion>;
  publish(templateId: string, mcp: string, versionId: string): Promise<HostedVersion>;
  retire(templateId: string, mcp: string, versionId: string): Promise<unknown>;
};

export function apiHostedClient(platformUrl: string, accessToken: string, fetchImpl: typeof fetch = fetch): HostedClient {
  const base = platformUrl.replace(/\/$/, '');
  const call = async <T>(method: string, templateId: string, mcp: string, rest = ''): Promise<T> => {
    const url = `${base}/api/templates/${templateId}/hosted/${encodeURIComponent(mcp)}/versions${rest}`;
    const res = await fetchImpl(url, { method, headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(320_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status, (body as { error?: string }).error ?? `${method} ${url} 回應 ${res.status}`);
    return body as T;
  };
  return {
    list: (t, m) => call('GET', t, m),
    create: (t, m) => call('POST', t, m),
    deploy: (t, m, v) => call('POST', t, m, `/${v}/deploy`),
    get: (t, m, v) => call('GET', t, m, `/${v}`),
    publish: (t, m, v) => call('POST', t, m, `/${v}/publish`),
    retire: (t, m, v) => call('DELETE', t, m, `/${v}`),
  };
}

/**
 * 內容與最新已發布版本相同就不建新版本（每個版本是一台機器）；否則部署新版本並發布。
 * 最後下架其他沒有專案在用的版本（含上次中斷留下的失敗、等待上傳版本），釋放機器。回傳是否部署了新版本
 */
async function deployHosted(db: Db, client: HostedClient, templateId: string, name: string, files: Files): Promise<boolean> {
  const latest = (await client.list(templateId, name)).find((v) => v.status === 'published');
  let keep = latest?.id;
  const deploy = !latest || (await storedHash(db, latest.bundle_path)) !== contentHash(files);
  if (deploy) {
    const { version, signedUrl } = await client.create(templateId, name);
    await putZip(signedUrl, zipSync(files), `代管 MCP「${name}」的套件`);
    let current = await client.deploy(templateId, name, version.id);
    // 部署靠讀取推進；超過 10 分鐘會自己標成失敗
    while (current.status === 'deploying') {
      await new Promise((r) => setTimeout(r, POLL_MS));
      current = await client.get(templateId, name, version.id);
    }
    if (current.status !== 'ready') throw new Error(`代管 MCP「${name}」部署失敗：\n${current.log_tail}`);
    await client.publish(templateId, name, version.id);
    keep = version.id;
  }
  for (const old of await client.list(templateId, name)) {
    if (old.id === keep || !canRetire(old)) continue;
    // 狀態可能剛好被別人改了或有專案剛租用，跳過即可，下次重跑再清
    await client.retire(templateId, name, old.id).catch((e) => { if (!(e instanceof HttpError && e.status === 409)) throw e; });
  }
  return deploy;
}

/** 以創作者身分建立或更新（依名稱比對）範本、上傳 skill zip、部署代管 MCP，再上架。 */
export async function publishDemoAgents(
  db: Db, creatorId: string, agents: DemoAgent[], hosted?: HostedClient,
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
      if (!hosted) throw new Error(`${agent.input.name} 有平台代管 MCP「${name}」，需要提供 HostedClient（見 scripts/seed-business-agents.ts）`);
      if (await deployHosted(db, hosted, t.id, name, files)) deployed.push(name);
    }
    await publishTemplate(db, creatorId, t.id);
    results.push({ id: t.id, name: agent.input.name, created: !current, deployed });
  }
  return results;
}
