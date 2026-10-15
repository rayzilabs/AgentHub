import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as jwks } from '@/app/.well-known/jwks.json/route';
import { POST } from '@/app/api/mcp/[instanceId]/[name]/route';
import { publicJwk, signProjectToken } from '@/lib/platform-tokens';
import { forwardToCreator, toolCallName } from '@/lib/services/remote-mcp';
import { createProject, deleteOwnProject, hireAgent } from '@/lib/services/projects';
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
  /** 先依序回這些，用完才回 reply */
  const queue: Reply[] = [];
  const seen: IncomingHttpHeaders[] = [];
  const methods: string[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      seen.push(req.headers);
      methods.push(req.method ?? '');
      req.resume();
      const r = queue.shift() ?? reply;
      res.writeHead(r.status ?? 200, r.headers ?? { 'content-type': 'application/json' });
      for (const c of r.chunks) {
        res.write(c);
        if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
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

  it('代管：Authorization 用平台的 Sprites token，創作者通行證只放 X-AgentHub-Token', async () => {
    reply = { chunks: ['{"jsonrpc":"2.0","id":1,"result":{}}'] };
    const res = await forwardToCreator(request(), '{}', `${base}/mcp`, 'creator-token', undefined, { edgeToken: 'sprites-token' });
    await res.text();
    expect(seen.at(-1)!.authorization).toBe('Bearer sprites-token');
    expect(seen.at(-1)!['x-agenthub-token']).toBe('creator-token');
  });

  it('代管 Sprite 喚醒中回 502／503：重試（最多 2 次）；沒有設定重試時照原樣回傳', async () => {
    reply = { chunks: ['{"jsonrpc":"2.0","id":1,"result":{}}'] };
    queue.push({ status: 503, chunks: ['waking'] }, { status: 502, chunks: ['waking'] });
    let before = seen.length;
    const results: boolean[] = [];
    const ok = await forwardToCreator(request(), '{}', `${base}/mcp`, 't', async (r) => { results.push(r); }, { retries: 2, retryDelayMs: 0 });
    expect(ok.status).toBe(200);
    await ok.text();
    expect(seen.length - before).toBe(3);
    expect(results).toEqual([true]);

    queue.push({ status: 503, chunks: ['a'] }, { status: 503, chunks: ['b'] }, { status: 503, chunks: ['c'] });
    before = seen.length;
    const down = await forwardToCreator(request(), '{}', `${base}/mcp`, 't', undefined, { retries: 2, retryDelayMs: 0 });
    expect(down.status).toBe(503);
    expect(await down.text()).toBe('c');
    expect(seen.length - before).toBe(3);

    queue.push({ status: 503, chunks: ['once'] });
    before = seen.length;
    const plain = await forwardToCreator(request(), '{}', `${base}/mcp`, 't');
    expect(plain.status).toBe(503);
    await plain.text();
    expect(seen.length - before).toBe(1);
  });

  it('代管的 tools/call：先用不帶通行證的 HEAD 叫醒（遇 502／503 重試），叫醒後 tools/call 只送一次', async () => {
    reply = { chunks: ['{"jsonrpc":"2.0","id":1,"result":{}}'] };
    queue.push({ status: 502, chunks: ['waking'] }, { status: 401, chunks: [] });
    const before = methods.length;
    const ok = await forwardToCreator(request(), '{}', `${base}/mcp`, 'creator', undefined,
      { edgeToken: 'sprites', wakeFirst: true, retries: 0, retryDelayMs: 0 });
    expect(ok.status).toBe(200);
    await ok.text();
    expect(methods.slice(before)).toEqual(['HEAD', 'HEAD', 'POST']);
    // 叫醒請求不帶創作者通行證，程式會以 401 拒絕，不會執行任何工具
    expect(seen.at(-2)!['x-agenthub-token']).toBeUndefined();
    expect(seen.at(-2)!.authorization).toBe('Bearer sprites');

    queue.push({ status: 401, chunks: [] }, { status: 502, chunks: ['crashed'] });
    const mark = methods.length;
    const crashed = await forwardToCreator(request(), '{}', `${base}/mcp`, 'creator', undefined,
      { edgeToken: 'sprites', wakeFirst: true, retries: 0, retryDelayMs: 0 });
    expect(crashed.status).toBe(502);
    await crashed.text();
    expect(methods.slice(mark)).toEqual(['HEAD', 'POST']);
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
  const received: { headers: IncomingHttpHeaders; body: string; url?: string; method?: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ headers: req.headers, body, url: req.url, method: req.method });
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
    vi.stubEnv('FLY_SPRITES_TOKEN', 'sprites-test');
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

  /** 代管版本的 sprite_url 指向本機假伺服器；版本被引用時不能刪，測試結束前先刪掉租用專案 */
  async function hiredHosted() {
    const creator = await seedUser(db);
    const owner = await seedUser(db);
    const t = await createTemplate(db, creator.id, {
      name: '代管顧問', description: '', category: '', system_prompt: 'p',
      mcp_servers: [{ name: 'fin', transport: 'remote', hosted: true, required_secrets: [] }],
    });
    const spriteUrl = mcpUrl.slice(0, -'/mcp'.length);
    const { data: v, error } = await db.from('hosted_mcp_versions').insert({
      template_id: t.id, mcp_name: 'fin', version: 1, status: 'published', bundle_path: 'x', sprite_name: 'agenthub-mcp-t', sprite_url: spriteUrl,
    }).select('id').single();
    if (error) throw error;
    await publishTemplate(db, creator.id, t.id);
    const p = await createProject(db, owner.id, 'p');
    const instanceId = await hireAgent(db, owner.id, p.id, t.id, {});
    return {
      creatorId: creator.id, templateId: t.id, projectId: p.id, instanceId, versionId: v.id as string, spriteUrl,
      cleanup: () => deleteOwnProject(db, owner.id, p.id),
    };
  }

  it('代管：轉到版本的 Sprite（/mcp），Fly 用 Sprites token、創作者通行證的 aud 是 Sprite 網址；記錄用量', async () => {
    const h = await hiredHosted();
    try {
      const before = received.length;
      const res = await call(h.instanceId, 'fin', signProjectToken(h.projectId, SECRET));
      expect(res.status).toBe(200);
      await res.text();
      // tools/call 前先叫醒代管 Sprite
      expect(received.slice(before).map((r) => r.method)).toEqual(['HEAD', 'POST']);
      const got = received.at(-1)!;
      expect(got.url).toBe('/mcp');
      expect(got.headers.authorization).toBe('Bearer sprites-test');
      const pl = (got.headers['x-agenthub-token'] as string).split('.')[1];
      expect(decode(pl)).toMatchObject({ aud: `${h.spriteUrl}/mcp`, sub: h.instanceId, project_id: h.projectId, template_id: h.templateId });
      const { data } = await db.from('mcp_usage').select('tool, ok, creator_id').eq('instance_id', h.instanceId);
      expect(data).toEqual([{ tool: 'rate', ok: true, creator_id: h.creatorId }]);
    } finally {
      await h.cleanup();
    }
  });

  it('代管：版本被停用 503、已下架 404', async () => {
    const h = await hiredHosted();
    try {
      const token = signProjectToken(h.projectId, SECRET);
      await db.from('hosted_mcp_versions').update({ status: 'disabled' }).eq('id', h.versionId);
      const disabled = await call(h.instanceId, 'fin', token);
      expect(disabled.status).toBe(503);
      expect(await disabled.json()).toEqual({ error: '這個工具服務已被暫停' });
      await db.from('hosted_mcp_versions').update({ status: 'retired' }).eq('id', h.versionId);
      expect((await call(h.instanceId, 'fin', token)).status).toBe(404);
    } finally {
      await h.cleanup();
    }
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
