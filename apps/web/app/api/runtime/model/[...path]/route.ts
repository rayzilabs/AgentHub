import { env } from '@/lib/env';
import { HttpError, route } from '@/lib/http';
import { verifyProjectToken } from '@/lib/platform-tokens';

export const maxDuration = 300;

type Ctx = { params: Promise<{ path: string[] }> };

/** runtime 的模型請求：驗證專案通行證後換上 Vertex 金鑰轉送；Sprite 上不放 Vertex 金鑰 */
async function handle(req: Request, { params }: Ctx): Promise<Response> {
  const secret = env.runtimeTokenSecret;
  if (!secret) throw new HttpError(503, '平台尚未設定專案通行證');
  // AI SDK 的 express mode 把 apiKey 放在 x-goog-api-key；runtime 放的是專案通行證
  const token = req.headers.get('x-goog-api-key');
  if (!token) throw new HttpError(401, '缺少專案通行證');
  const projectId = verifyProjectToken(token, secret);
  const { path } = await params;
  // 路徑原樣接上（模型名稱含冒號，例如 models/gemini-x:streamGenerateContent），但不允許跳出 Vertex 的路徑
  if (path.some((p) => p === '..' || p === '.' || p === '' || p.includes('\\'))) throw new HttpError(400, '路徑不正確');
  const target = `${env.vertexBaseUrl}/${path.join('/')}${new URL(req.url).search}`;
  const headers = new Headers({ 'x-goog-api-key': env.vertexKey });
  for (const k of ['content-type', 'accept']) {
    const v = req.headers.get(k);
    if (v) headers.set(k, v);
  }
  const started = Date.now();
  const upstream = await fetch(target, { method: 'POST', headers, body: await req.text(), signal: req.signal });
  console.log(JSON.stringify({ event: 'model_proxy', project_id: projectId, path: path.join('/'), status: upstream.status, ms: Date.now() - started }));
  const out = new Headers();
  const type = upstream.headers.get('content-type');
  if (type) out.set('content-type', type);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const POST = route(handle);
