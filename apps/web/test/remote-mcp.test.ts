import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as jwks } from '@/app/.well-known/jwks.json/route';
import { POST } from '@/app/api/mcp/[instanceId]/[name]/route';
import { publicJwk, signProjectToken } from '@/lib/platform-tokens';
import { forwardToCreator, toolCallName } from '@/lib/services/remote-mcp';
import { createProject, hireAgent } from '@/lib/services/projects';
import { createTemplate, publishTemplate } from '@/lib/services/templates';
import { seedUser, testDb } from './helpers';

const db = testDb();
const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SECRET = 'test-secret-for-gateway-at-least-32-chars';
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('toolCallName', () => {
  it('只在 tools/call 時回傳工具名稱', () => {
    expect(toolCallName('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"rate"}}')).toBe('rate');
    expect(toolCallName('[{"method":"notifications/x"},{"method":"tools/call","params":{"name":"b"}}]')).toBe('b');
    expect(toolCallName('{"method":"tools/list"}')).toBeNull();
    expect(toolCallName('not json')).toBeNull();
    expect(toolCallName(undefined)).toBeNull();
  });
});

describe('forwardToCreator', () => {
  type Reply = { status?: number; headers?: Record<string, string>; chunks: string[]; delayMs?: number };
  let server: Server;
  let base: string;
  let reply: Reply;
  const seen: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      seen.push(req.headers);
      req.resume();
      res.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'application/json' });
      for (const c of reply.chunks) {
        res.write(c);
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  const request = (headers: Record<string, string> = {}) => new Request('https://p.test/api/mcp/i/fin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'c=1', authorization: 'Bearer project', ...headers },
    body: '{}',
  });

  it('轉送 MCP 標準標頭（含 Mcp-Method、Mcp-Name、Mcp-Param-*），不轉 cookie 與原本的 Authorization', async () => {
    reply = { chunks: ['{"jsonrpc":"2.0","id":1,"result":{}}'] };
    const res = await forwardToCreator(request({ 'mcp-method': 'tools/call', 'mcp-name': 'rate', 'mcp-param-region': 'tw' }), '{}', `${base}/mcp`, 'creator-token');
    await res.text();
    const h = seen.at(-1)!;
    expect(h['mcp-method']).toBe('tools/call');
    expect(h['mcp-name']).toBe('rate');
    expect(h['mcp-param-region']).toBe('tw');
    expect(h.cookie).toBeUndefined();
    expect(h.authorization).toBe('Bearer creator-token');
    expect(h['x-agenthub-token']).toBe('creator-token');
  });

  it('創作者端要求轉址時不跟過去：回 502、記為失敗', async () => {
    reply = { status: 307, headers: { location: `${base}/elsewhere` }, chunks: [] };
    const results: boolean[] = [];
    const before = seen.length;
    const e = await forwardToCreator(request(), '{}', `${base}/mcp`, 't', async (ok) => { results.push(ok); }).catch((err) => err);
    expect(e.status).toBe(502);
    expect(seen.length).toBe(before + 1);
    expect(results).toEqual([false]);
  });

  it('用量在回應結束後才記錄：耗時包含串流時間；SSE 裡的 JSON-RPC 錯誤或 isError 記為失敗', async () => {
    reply = {
      headers: { 'content-type': 'text/event-stream' },
      chunks: ['event: message\n', 'data: {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[]}}\n\n'],
      delayMs: 150,
    };
    const results: boolean[] = [];
    const started = Date.now();
    let recordedAt = 0;
    const res = await forwardToCreator(request(), '{}', `${base}/mcp`, 't', async (ok) => { results.push(ok); recordedAt = Date.now(); });
    expect(results).toEqual([]);
    expect(await res.text()).toContain('"isError":true');
    expect(results).toEqual([false]);
    expect(recordedAt - started).toBeGreaterThanOrEqual(250);

    reply = { chunks: ['{"jsonrpc":"2.0","id":1,"result":{"content":[]}}'] };
    await (await forwardToCreator(request(), '{}', `${base}/mcp`, 't', async (ok) => { results.push(ok); })).text();
    reply = { chunks: ['{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"x"}}'] };
    await (await forwardToCreator(request(), '{}', `${base}/mcp`, 't', async (ok) => { results.push(ok); })).text();
    expect(results).toEqual([false, true, false]);
  });

  it('呼叫端中途取消（run 結束）不記為創作者失敗', async () => {
    reply = { headers: { 'content-type': 'text/event-stream' }, chunks: ['data: {}\n\n', 'data: {}\n\n'], delayMs: 300 };
    const results: boolean[] = [];
    const res = await forwardToCreator(request(), '{}', `${base}/mcp`, 't', async (ok) => { results.push(ok); });
    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 400));
    expect(results).toEqual([]);
  });
});

describe('遠端 MCP 閘道', () => {
  let server: Server;
  let mcpUrl: string;
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        res.setHeader('mcp-session-id', 's-1');
        res.end('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"1.23"}]}}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    vi.stubEnv('RUNTIME_TOKEN_SECRET', SECRET);
    vi.stubEnv('MCP_SIGNING_KEY', pem);
    vi.stubEnv('PLATFORM_URL', 'https://p.test');
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
  });

  async function hired(url = mcpUrl) {
    const creator = await seedUser(db);
    const owner = await seedUser(db);
    // createTemplate 不經過 schema，可以用本機 http 網址
    const t = await createTemplate(db, creator.id, {
      name: '金融顧問', description: '', category: '', system_prompt: '你是金融顧問',
      mcp_servers: [{ name: 'fin', transport: 'remote', url, required_secrets: [] }],
    });
    await publishTemplate(db, creator.id, t.id);
    const p = await createProject(db, owner.id, 'p');
    const instanceId = await hireAgent(db, owner.id, p.id, t.id, {});
    return { creatorId: creator.id, templateId: t.id, projectId: p.id, instanceId };
  }

  const TOOL_CALL = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"rate","arguments":{}}}';
  const call = (instanceId: string, name: string, token?: string, body = TOOL_CALL) => POST(
    new Request(`https://p.test/api/mcp/${instanceId}/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: 'sb-session=secret',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
    }),
    { params: Promise.resolve({ instanceId, name }) },
  );

  it('轉送給創作者並附上可驗證的通行證；不轉 cookie；記錄用量', async () => {
    const h = await hired();
    const res = await call(h.instanceId, 'fin', signProjectToken(h.projectId, SECRET));
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe('s-1');
    expect(await res.text()).toContain('1.23');

    const got = received.at(-1)!;
    expect(got.body).toContain('"tools/call"');
    expect(got.headers.cookie).toBeUndefined();
    const token = got.headers['x-agenthub-token'] as string;
    expect(got.headers.authorization).toBe(`Bearer ${token}`);
    const [hd, pl, sig] = token.split('.');
    const key = createPublicKey({ key: publicJwk(pem), format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${hd}.${pl}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(decode(pl)).toMatchObject({
      iss: 'https://p.test', aud: mcpUrl, sub: h.instanceId, project_id: h.projectId, template_id: h.templateId,
    });

    const { data } = await db.from('mcp_usage').select('tool, ok, mcp_name, creator_id, project_id').eq('instance_id', h.instanceId);
    expect(data).toEqual([{ tool: 'rate', ok: true, mcp_name: 'fin', creator_id: h.creatorId, project_id: h.projectId }]);
  });

  it('沒有通行證 401、別的專案 403、MCP 名稱不存在 404、顧問被移除後拒絕', async () => {
    const h = await hired();
    const other = await hired();
    const token = signProjectToken(h.projectId, SECRET);
    expect((await call(h.instanceId, 'fin')).status).toBe(401);
    expect((await call(other.instanceId, 'fin', token)).status).toBe(403);
    expect((await call(h.instanceId, 'nope', token)).status).toBe(404);

    await db.from('agent_instances').delete().eq('id', h.instanceId);
    expect((await call(h.instanceId, 'fin', token)).status).toBe(404);
  });

  it('公開 JWKS：可快取；設定舊金鑰時新舊並列（輪換用）', async () => {
    const res = await jwks(new Request('https://p.test/.well-known/jwks.json'), {});
    expect(await res.json()).toEqual({ keys: [publicJwk(pem)] });
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');

    const old = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    vi.stubEnv('MCP_SIGNING_KEY_PREVIOUS', old);
    const both = await (await jwks(new Request('https://p.test/.well-known/jwks.json'), {})).json();
    expect(both).toEqual({ keys: [publicJwk(pem), publicJwk(old)] });
    vi.stubEnv('MCP_SIGNING_KEY_PREVIOUS', '');
  });

  it('顧問 id 不是 UUID 時回 404，不是 500', async () => {
    const h = await hired();
    expect((await call('not-a-uuid', 'fin', signProjectToken(h.projectId, SECRET))).status).toBe(404);
  });

  it('過期的專案通行證回 401', async () => {
    const h = await hired();
    const expired = signProjectToken(h.projectId, SECRET, Date.now() - 21 * 60_000);
    expect((await call(h.instanceId, 'fin', expired)).status).toBe(401);
  });

  it('創作者端連不上：502，用量記為失敗', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/mcp`;
    await new Promise((resolve) => closed.close(resolve));
    const h = await hired(deadUrl);
    expect((await call(h.instanceId, 'fin', signProjectToken(h.projectId, SECRET))).status).toBe(502);
    const { data } = await db.from('mcp_usage').select('tool, ok').eq('instance_id', h.instanceId);
    expect(data).toEqual([{ tool: 'rate', ok: false }]);
  });

  it('不是 tools/call 的請求照常轉送，但不記用量', async () => {
    const h = await hired();
    const res = await call(h.instanceId, 'fin', signProjectToken(h.projectId, SECRET), '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(res.status).toBe(200);
    await res.text();
    const { data } = await db.from('mcp_usage').select('id').eq('instance_id', h.instanceId);
    expect(data).toEqual([]);
  });
});
