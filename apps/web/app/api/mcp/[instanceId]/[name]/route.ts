import { env } from '@/lib/env';
import { HttpError, route } from '@/lib/http';
import { signCreatorToken, verifyProjectToken } from '@/lib/platform-tokens';
import { forwardToCreator, recordUsage, resolveRemoteTarget, toolCallName } from '@/lib/services/remote-mcp';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

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
  const started = Date.now();
  const onEnd = tool
    ? (ok: boolean) => recordUsage(db, {
        project_id: projectId, instance_id: instanceId, template_id: target.templateId, creator_id: target.creatorId,
        mcp_name: name, tool, ok, duration_ms: Date.now() - started,
      }).catch((e) => console.error('[mcp] 無法記錄用量', e))
    : undefined;
  // 代管 Sprite 可能在休眠：tools/call 先叫醒、只送一次（有副作用的工具不能重送）；其他請求遇 502／503 重試
  const hosted = target.edgeToken
    ? { edgeToken: target.edgeToken, retries: tool ? 0 : 2, wakeFirst: tool !== null, retryDelayMs: 1000 }
    : {};
  return forwardToCreator(req, body, target.url, token, onEnd, hosted);
}

export const POST = route(handle);
export const GET = route(handle);
export const DELETE = route(handle);
