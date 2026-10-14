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

  const call = (path: string[], headers: Record<string, string>) => POST(
    new Request(`https://p.test/api/runtime/model/${path.join('/')}?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'sb=1', ...headers },
      body: '{"contents":[]}',
    }),
    { params: Promise.resolve({ path }) },
  );

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
