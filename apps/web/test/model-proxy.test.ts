import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/runtime/model/[...path]/route';
import { signProjectToken } from '@/lib/platform-tokens';

const SECRET = 'test-secret-for-model-proxy-32-chars!';

describe('模型代理', () => {
  let server: Server;
  const seen: { url?: string; headers: IncomingHttpHeaders; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        if (req.url?.includes('fail-model')) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { code: 400, message: 'The input token count exceeds the maximum number of tokens allowed 32768.', status: 'INVALID_ARGUMENT' } }));
          return;
        }
        res.setHeader('content-type', 'text/event-stream');
        res.write('data: {"a":1}\n\n');
        res.end('data: {"a":2}\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    vi.stubEnv('VERTEX_BASE_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/publishers/google`);
    vi.stubEnv('VERTEX_API_EXPRESS_MODE_KEY', 'real-key');
    vi.stubEnv('RUNTIME_TOKEN_SECRET', SECRET);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (path: string[], headers: Record<string, string>, body = '{"contents":[]}') => POST(
    new Request(`https://p.test/api/runtime/model/${path.join('/')}?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'sb=1', ...headers },
      body,
    }),
    { params: Promise.resolve({ path }) },
  );

  it('上游回錯誤時，錯誤訊息附上請求形狀（只有角色、類型、工具名與字元數，不含內容）', async () => {
    const secretText = '不可以出現在診斷裡的內容';
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [
        { role: 'user', parts: [{ text: secretText }] },
        { role: 'model', parts: [{ functionCall: { name: 'etf__report_inputs', args: {} }, thoughtSignature: 'sig'.repeat(10) }] },
        { role: 'user', parts: [{ functionResponse: { name: 'etf__report_inputs', response: { content: 'x'.repeat(5000) } } }] },
      ],
    });
    const res = await call(['models', 'fail-model:streamGenerateContent'], { 'x-goog-api-key': signProjectToken('p1', SECRET) }, body);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.message).toContain('The input token count exceeds the maximum number of tokens allowed 32768.');
    expect(error.message).toContain('[診斷]');
    expect(error.message).toMatch(/#2 user functionResponse:etf__report_inputs \d{4,}/);
    expect(error.message).toContain('sig=30');
    expect(error.message).not.toContain(secretText);
  });

  it('驗證專案通行證後換上 Vertex 金鑰轉送，串流原樣回傳', async () => {
    const res = await call(['models', 'gemini-x:streamGenerateContent'], { 'x-goog-api-key': signProjectToken('p1', SECRET) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('data: {"a":1}\n\ndata: {"a":2}\n\n');
    const got = seen.at(-1)!;
    expect(got.url).toBe('/v1/publishers/google/models/gemini-x:streamGenerateContent?alt=sse');
    expect(got.headers['x-goog-api-key']).toBe('real-key');
    expect(got.headers.cookie).toBeUndefined();
    expect(got.body).toBe('{"contents":[]}');
  });

  it('沒有或錯誤的通行證回 401，不會轉送', async () => {
    const before = seen.length;
    expect((await call(['models', 'g:generateContent'], {})).status).toBe(401);
    expect((await call(['models', 'g:generateContent'], { 'x-goog-api-key': 'nope' })).status).toBe(401);
    expect(seen.length).toBe(before);
  });

  it('只轉送模型呼叫的路徑；其他路徑（含 .. 與解碼後的 %2F）回 400，不會轉送', async () => {
    const before = seen.length;
    const token = { 'x-goog-api-key': signProjectToken('p1', SECRET) };
    for (const path of [['..', 'secrets'], ['../../x'], ['models', 'g:delete'], ['projects', 'p', 'keys'], ['models', '..%2Fx:generateContent']]) {
      expect((await call(path, token)).status).toBe(400);
    }
    expect(seen.length).toBe(before);
    expect((await call(['models', 'gemini-3.8-flash:generateContent'], token)).status).toBe(200);
  });
});
