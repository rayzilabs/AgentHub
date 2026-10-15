import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { signCreatorToken } from '@/lib/platform-tokens';
import type { Db } from '@/lib/supabase/admin';
import { getOwnTemplate } from './templates';

export const HOSTED_LIMITS = { publishedPerMcp: 3, spritesPerCreator: 10, bundleBytes: 50 * 1024 * 1024, deployMs: 10 * 60_000 };

const BUCKET = 'mcp-bundles';
const LOG_LINES = 100;
/** 平台注入的變數；AGENTHUB_ 開頭整個保留給平台 */
const isReservedKey = (key: string) => key === 'PORT' || key.startsWith('AGENTHUB_');

export type HostedVersion = {
  id: string; template_id: string; mcp_name: string; version: number; status: string;
  bundle_path: string; sprite_name: string | null; sprite_url: string | null; tools: unknown[]; log_tail: string;
  deploy_started_at: string | null; created_at: string; published_at: string | null;
};

export type DeployState =
  | { phase: 'installing'; log: string }
  | { phase: 'installed'; start: string; log: string }
  | { phase: 'failed'; error: string; log: string };

export type HostedSpriteOps = {
  provision(version: HostedVersion, env: Record<string, string>, bundleUrl: string): Promise<{ spriteName: string; spriteUrl: string }>;
  readState(spriteName: string): Promise<DeployState>;
  startService(spriteName: string, start: string): Promise<void>;
  listTools(spriteUrl: string, creatorToken: string): Promise<{ name: string; description?: string }[]>;
  /** 改寫 env.sh 並重啟 mcp 服務 */
  applyEnv(spriteName: string, env: Record<string, string>): Promise<void>;
  destroy(spriteName: string): Promise<void>;
};

/** 套件大小檢查；超過 50 MB 丟 HttpError(400) */
export function checkBundle(size: number | undefined): void {
  if (typeof size !== 'number') throw new HttpError(400, '讀不到套件大小，請重新上傳');
  if (size > HOSTED_LIMITS.bundleBytes) throw new HttpError(400, '套件超過 50 MB');
}

/** 驗證 mcp.json 內容，回傳標準化設定；不合格丟 Error（訊息給創作者看） */
export function parseMcpJson(text: string): { runtime: 'python' | 'node'; start: string; install?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('mcp.json 不是有效的 JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mcp.json 必須是物件');
  const { runtime, start, install } = raw as Record<string, unknown>;
  if (runtime !== 'python' && runtime !== 'node') throw new Error('mcp.json 的 runtime 必須是 python 或 node');
  if (typeof start !== 'string' || !start.trim()) throw new Error('mcp.json 需要 start（啟動指令）');
  if (install !== undefined && (typeof install !== 'string' || !install.trim())) throw new Error('mcp.json 的 install 必須是檔名');
  return install === undefined ? { runtime, start } : { runtime, start, install };
}

function tail(text: string, lines = LOG_LINES): string {
  return text.split('\n').slice(-lines).join('\n');
}

async function ownHostedMcp(db: Db, userId: string, templateId: string, mcpName: string): Promise<void> {
  const template = await getOwnTemplate(db, userId, templateId);
  const ok = template.mcp_servers.some((s) => s.name === mcpName && s.transport === 'remote' && s.hosted === true);
  if (!ok) throw new HttpError(400, '這個 MCP 不是平台代管');
}

async function loadVersion(db: Db, versionId: string): Promise<HostedVersion> {
  const { data, error } = await db.from('hosted_mcp_versions').select('*').eq('id', versionId).maybeSingle();
  if (error?.code === '22P02' || (!error && !data)) throw new HttpError(404, '找不到這個版本');
  if (error) throw error;
  return data as HostedVersion;
}

async function ownVersion(db: Db, userId: string, versionId: string): Promise<HostedVersion> {
  const version = await loadVersion(db, versionId);
  await getOwnTemplate(db, userId, version.template_id);
  return version;
}

/** 只在狀態仍是 from 時更新，避免兩個請求同時推進同一個版本 */
async function updateVersion(db: Db, id: string, from: string, patch: Partial<HostedVersion>): Promise<HostedVersion> {
  const { data, error } = await db.from('hosted_mcp_versions').update(patch).eq('id', id).eq('status', from).select('*').maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(409, '版本狀態已經改變，請重新整理');
  return data as HostedVersion;
}

async function hostedEnv(db: Db, templateId: string, mcpName: string, spriteUrl: string | null): Promise<Record<string, string>> {
  const { data, error } = await db.rpc('get_hosted_mcp_secrets', { p_template_id: templateId, p_mcp_name: mcpName });
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as { key: string; value: string }[]) out[row.key] = row.value;
  out.PORT = '8080';
  // 建立 Sprite 前還不知道網址，由 provision 補上
  if (spriteUrl) out.AGENTHUB_MCP_URL = `${spriteUrl}/mcp`;
  out.AGENTHUB_PLATFORM_URL = env.platformUrl;
  return out;
}

/** 路由用：版本必須屬於網址上的範本與 MCP，且範本是自己的 */
export async function getVersion(db: Db, userId: string, templateId: string, mcpName: string, versionId: string): Promise<HostedVersion> {
  const version = await ownVersion(db, userId, versionId);
  if (version.template_id !== templateId || version.mcp_name !== mcpName) throw new HttpError(404, '找不到這個版本');
  return version;
}

export async function listVersions(db: Db, userId: string, templateId: string, mcpName: string): Promise<HostedVersion[]> {
  await ownHostedMcp(db, userId, templateId, mcpName);
  const { data, error } = await db.from('hosted_mcp_versions').select('*')
    .eq('template_id', templateId).eq('mcp_name', mcpName).order('version', { ascending: false });
  if (error) throw error;
  return data as HostedVersion[];
}

export async function createVersion(
  db: Db, userId: string, templateId: string, mcpName: string,
): Promise<{ version: HostedVersion; signedUrl: string }> {
  await ownHostedMcp(db, userId, templateId, mcpName);
  const { data: rows, error } = await db.from('hosted_mcp_versions').select('version, status')
    .eq('template_id', templateId).eq('mcp_name', mcpName);
  if (error) throw error;
  if (rows.some((r) => r.status === 'pending' || r.status === 'deploying')) throw new HttpError(409, '已有版本正在部署');
  const published = rows.filter((r) => r.status === 'published').length;
  if (published >= HOSTED_LIMITS.publishedPerMcp) {
    throw new HttpError(409, `已發布 ${published} 個版本，請先下架沒有專案使用的舊版本`);
  }
  // 等上傳與部署中的版本馬上會有 Sprite，也算進上限
  const { count, error: countError } = await db.from('hosted_mcp_versions')
    .select('id, agent_templates!inner(creator_id)', { count: 'exact', head: true })
    .eq('agent_templates.creator_id', userId)
    .or('status.in.(pending,deploying),and(sprite_name.not.is.null,status.neq.retired)');
  if (countError) throw countError;
  if ((count ?? 0) >= HOSTED_LIMITS.spritesPerCreator) {
    throw new HttpError(409, `代管 Sprite 已達 ${HOSTED_LIMITS.spritesPerCreator} 台上限`);
  }

  const version = Math.max(0, ...rows.map((r) => r.version as number)) + 1;
  const bundlePath = `${templateId}/${mcpName}/${version}.zip`;
  const { data, error: insertError } = await db.from('hosted_mcp_versions')
    .insert({ template_id: templateId, mcp_name: mcpName, version, status: 'pending', bundle_path: bundlePath })
    .select('*').single();
  if (insertError?.code === '23505') throw new HttpError(409, '已有版本正在部署');
  if (insertError) throw insertError;
  const { data: upload, error: uploadError } = await db.storage.from(BUCKET).createSignedUploadUrl(bundlePath, { upsert: true });
  if (uploadError) throw uploadError;
  return { version: data as HostedVersion, signedUrl: upload.signedUrl };
}

/** pending → deploying（檢查已上傳、大小）；實際部署由 syncVersion 推進 */
export async function startDeploy(db: Db, userId: string, versionId: string): Promise<HostedVersion> {
  const version = await ownVersion(db, userId, versionId);
  if (version.status !== 'pending') throw new HttpError(409, '這個版本已經開始部署');
  const file = `${version.version}.zip`;
  const { data: files, error } = await db.storage.from(BUCKET).list(`${version.template_id}/${version.mcp_name}`, { search: file });
  if (error) throw error;
  const uploaded = files?.find((f) => f.name === file);
  if (!uploaded) throw new HttpError(400, '還沒有上傳套件');
  checkBundle(uploaded.metadata?.size as number | undefined);
  return updateVersion(db, version.id, 'pending', { status: 'deploying', deploy_started_at: new Date().toISOString() });
}

export async function syncVersion(db: Db, versionId: string, sprites: HostedSpriteOps, now = Date.now()): Promise<HostedVersion> {
  let version = await loadVersion(db, versionId);
  if (version.status !== 'deploying') return version;
  const fail = (reason: string, log: string) =>
    updateVersion(db, version.id, 'deploying', { status: 'failed', log_tail: tail(log ? `${reason}\n${tail(log, LOG_LINES - 1)}` : reason) });

  const started = version.deploy_started_at ? Date.parse(version.deploy_started_at) : 0;
  if (now - started > HOSTED_LIMITS.deployMs) return fail('部署逾時（超過 10 分鐘）', version.log_tail);

  if (!version.sprite_name) {
    const { data: signed, error } = await db.storage.from(BUCKET).createSignedUrl(version.bundle_path, 900);
    if (error) throw error;
    const vars = await hostedEnv(db, version.template_id, version.mcp_name, null);
    const { spriteName, spriteUrl } = await sprites.provision(version, vars, signed.signedUrl);
    version = await updateVersion(db, version.id, 'deploying', { sprite_name: spriteName, sprite_url: spriteUrl });
  }
  const spriteName = version.sprite_name!;
  const state = await sprites.readState(spriteName);
  if (state.phase === 'failed') return fail(state.error, state.log);
  if (state.phase === 'installing') return updateVersion(db, version.id, 'deploying', { log_tail: tail(state.log) });

  await sprites.startService(spriteName, state.start);
  const spriteUrl = version.sprite_url!;
  const token = signCreatorToken(
    { iss: env.platformUrl, aud: `${spriteUrl}/mcp`, sub: 'deploy-check', project_id: 'deploy-check', template_id: version.template_id },
    env.mcpSigningKey,
  );
  let tools: { name: string; description?: string }[];
  try {
    tools = await sprites.listTools(spriteUrl, token);
  } catch (e) {
    // 程式可能還在啟動；下次讀取再試，超過 10 分鐘會標成逾時
    const reason = e instanceof Error ? e.message : String(e);
    return updateVersion(db, version.id, 'deploying', { log_tail: tail(`${state.log}\n等待程式回應：${reason}`) });
  }
  if (tools.length === 0) return fail('沒有任何工具', state.log);
  return updateVersion(db, version.id, 'deploying', { status: 'ready', tools, log_tail: tail(state.log) });
}

export async function publishVersion(db: Db, userId: string, versionId: string): Promise<HostedVersion> {
  const version = await ownVersion(db, userId, versionId);
  if (version.status !== 'ready') throw new HttpError(409, '只有部署成功的版本可以發布');
  const { count, error } = await db.from('hosted_mcp_versions').select('id', { count: 'exact', head: true })
    .eq('template_id', version.template_id).eq('mcp_name', version.mcp_name).eq('status', 'published');
  if (error) throw error;
  if ((count ?? 0) >= HOSTED_LIMITS.publishedPerMcp) {
    throw new HttpError(409, `已發布 ${count} 個版本，請先下架沒有專案使用的舊版本`);
  }
  return updateVersion(db, version.id, 'ready', { status: 'published', published_at: new Date().toISOString() });
}

export async function retireVersion(db: Db, userId: string, versionId: string, sprites: HostedSpriteOps): Promise<HostedVersion> {
  const version = await ownVersion(db, userId, versionId);
  if (!['ready', 'failed', 'published'].includes(version.status)) throw new HttpError(409, '這個版本不能下架');
  // 先標 retired 擋住新的租用，再檢查有沒有專案在用
  let retired = await updateVersion(db, version.id, version.status, { status: 'retired' });
  const { count, error } = await db.from('remote_mcp_targets').select('instance_id', { count: 'exact', head: true })
    .eq('hosted_version_id', version.id);
  if (error || (count ?? 0) > 0) {
    await updateVersion(db, version.id, 'retired', { status: version.status });
    if (error) throw error;
    throw new HttpError(409, '還有專案在使用這個版本');
  }
  if (version.sprite_name) {
    await sprites.destroy(version.sprite_name);
    retired = await updateVersion(db, version.id, 'retired', { sprite_name: null });
  }
  return retired;
}

export async function setHostedSecrets(
  db: Db, userId: string, templateId: string, mcpName: string, secrets: Record<string, string>, sprites: HostedSpriteOps,
): Promise<void> {
  await ownHostedMcp(db, userId, templateId, mcpName);
  for (const key of Object.keys(secrets)) {
    if (isReservedKey(key)) throw new HttpError(400, `「${key}」是平台保留的名稱`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new HttpError(400, `金鑰名稱「${key}」只能用大寫英文、數字和底線，且以英文開頭`);
  }
  for (const [key, value] of Object.entries(secrets)) {
    const { error } = await db.rpc('set_hosted_mcp_secret', { p_template_id: templateId, p_mcp_name: mcpName, p_key: key, p_value: value });
    if (error) throw error;
  }
  const { data: running, error } = await db.from('hosted_mcp_versions').select('sprite_name, sprite_url')
    .eq('template_id', templateId).eq('mcp_name', mcpName).in('status', ['ready', 'published']).not('sprite_name', 'is', null);
  if (error) throw error;
  for (const v of running as { sprite_name: string; sprite_url: string }[]) {
    await sprites.applyEnv(v.sprite_name, await hostedEnv(db, templateId, mcpName, v.sprite_url));
  }
}
