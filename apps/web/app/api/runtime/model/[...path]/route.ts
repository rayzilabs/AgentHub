import { env } from '@/lib/env';
import { HttpError, route } from '@/lib/http';
import { describeRequest } from '@/lib/model-diagnostics';
import { verifyProjectToken } from '@/lib/platform-tokens';

export const maxDuration = 300;

type Ctx = { params: Promise<{ path: string[] }> };

const MODEL_PATH = /^models\/[\w.-]+:(generateContent|streamGenerateContent|countTokens)$/;

/** runtime 的模型請求：驗證專案通行證後換上 Vertex 金鑰轉送；Sprite 上不放 Vertex 金鑰 */
async function handle(req: Request, { params }: Ctx): Promise<Response> {
  const secret = env.runtimeTokenSecret;
  if (!secret) throw new HttpError(503, '平台尚未設定專案通行證');
  // AI SDK 的 express mode 把 apiKey 放在 x-goog-api-key；runtime 放的是專案通行證
  const token = req.headers.get('x-goog-api-key');
  if (!token) throw new HttpError(401, '缺少專案通行證');
  const projectId = verifyProjectToken(token, secret);
  const { path } = await params;
  // 只放行模型呼叫（白名單）：避免被攻破的 Sprite 拿平台的 Vertex 金鑰打其他 API。
  // Next 會先切段再解碼，%2F 會變成段內的 /，所以檢查接起來的完整路徑
  const joined = path.join('/');
  if (!MODEL_PATH.test(joined)) throw new HttpError(400, '路徑不正確');
  const target = `${env.vertexBaseUrl}/${joined}${new URL(req.url).search}`;
  const headers = new Headers({ 'x-goog-api-key': env.vertexKey });
  for (const k of ['content-type', 'accept']) {
    const v = req.headers.get(k);
    if (v) headers.set(k, v);
  }
  const started = Date.now();
  const body = await req.text();
  const upstream = await fetch(target, { method: 'POST', headers, body, signal: req.signal });
  console.log(JSON.stringify({ event: 'model_proxy', project_id: projectId, path: path.join('/'), status: upstream.status, ms: Date.now() - started }));
  if (!upstream.ok) return withDiagnosis(upstream, body, projectId);
  const out = new Headers();
  const type = upstream.headers.get('content-type');
  if (type) out.set('content-type', type);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/**
 * 上游回錯誤時，在錯誤訊息後附上請求形狀（不含內容）。runtime 會把錯誤訊息存進 runs.error，
 * 不必有 Vercel 權限也查得到是哪一段造成的。
 */
async function withDiagnosis(upstream: Response, body: string, projectId: string): Promise<Response> {
  const text = await upstream.text();
  const diagnosis = describeRequest(body);
  console.log(JSON.stringify({ event: 'model_proxy_error', project_id: projectId, status: upstream.status, error: text.slice(0, 500), diagnosis }));
  let out = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error) {
      parsed.error.message = `${parsed.error.message ?? ''} ${diagnosis}`;
      out = JSON.stringify(parsed);
    }
  } catch {
    // 不是 JSON 就原樣回傳
  }
  return new Response(out, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } });
}

export const POST = route(handle);
