import { env } from '@/lib/env';
import { HttpError, route } from '@/lib/http';
import { signCreatorToken, verifyProjectToken } from '@/lib/platform-tokens';
import { recordUsage, resolveRemoteTarget, toolCallName } from '@/lib/services/remote-mcp';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

/** 只轉 MCP 需要的請求標頭；請求方的 cookie、Authorization 等一律不轉 */
const FORWARD = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const HOP_BY_HOP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive', 'content-encoding']);

type Ctx = { params: Promise<{ instanceId: string; name: string }> };

async function handle(req: Request, { params }: Ctx): Promise<Response> {
  const { instanceId, name } = await params;
  const secret = env.runtimeTokenSecret;
  if (!secret) throw new HttpError(503, '平台尚未設定專案通行證');
  const bearer = req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!bearer) throw new HttpError(401, '缺少專案通行證');
  const projectId = verifyProjectToken(bearer, secret);
  const db = adminDb();
  const target = await resolveRemoteTarget(db, instanceId, name, projectId);

  const body = req.method === 'POST' ? await req.text() : undefined;
  const tool = toolCallName(body);
  const token = signCreatorToken(
    { iss: env.platformUrl, aud: target.url, sub: instanceId, project_id: projectId, template_id: target.templateId },
    env.mcpSigningKey,
  );
  const headers = new Headers();
  for (const k of FORWARD) {
    const v = req.headers.get(k);
    if (v) headers.set(k, v);
  }
  headers.set('x-agenthub-token', token);
  headers.set('authorization', `Bearer ${token}`);

  const started = Date.now();
  const usage = async (ok: boolean) => {
    if (!tool) return;
    await recordUsage(db, {
      project_id: projectId, instance_id: instanceId, template_id: target.templateId, creator_id: target.creatorId,
      mcp_name: name, tool, ok, duration_ms: Date.now() - started,
    }).catch((e) => console.error('[mcp] 無法記錄用量', e));
  };
  let upstream: Response;
  try {
    upstream = await fetch(target.url, { method: req.method, headers, body, signal: req.signal });
  } catch {
    await usage(false);
    throw new HttpError(502, '工具服務無法連線');
  }
  await usage(upstream.ok);
  const out = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k)) out.set(k, v);
  });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const POST = route(handle);
export const GET = route(handle);
export const DELETE = route(handle);
