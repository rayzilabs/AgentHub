import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as jwks } from '@/app/.well-known/jwks.json/route';
import { POST } from '@/app/api/mcp/[instanceId]/[name]/route';
import { publicJwk, signProjectToken } from '@/lib/platform-tokens';
import { toolCallName } from '@/lib/services/remote-mcp';
import { createProject, hireAgent } from '@/lib/services/projects';
import { createTemplate, publishTemplate } from '@/lib/services/templates';
import { seedUser, testDb } from './helpers';

const db = testDb();
const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
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
    vi.stubEnv('RUNTIME_TOKEN_SECRET', 'test-secret');
    vi.stubEnv('MCP_SIGNING_KEY', pem);
    vi.stubEnv('PLATFORM_URL', 'https://p.test');
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
  });

  async function hired() {
    const creator = await seedUser(db);
    const owner = await seedUser(db);
    // createTemplate 不經過 schema，可以用本機 http 網址
    const t = await createTemplate(db, creator.id, {
      name: '金融顧問', description: '', category: '', system_prompt: '你是金融顧問',
      mcp_servers: [{ name: 'fin', transport: 'remote', url: mcpUrl, required_secrets: [] }],
    });
    await publishTemplate(db, creator.id, t.id);
    const p = await createProject(db, owner.id, 'p');
    const instanceId = await hireAgent(db, owner.id, p.id, t.id, {});
    return { creatorId: creator.id, templateId: t.id, projectId: p.id, instanceId };
  }

  const call = (instanceId: string, name: string, token?: string) => POST(
    new Request(`https://p.test/api/mcp/${instanceId}/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: 'sb-session=secret',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"rate","arguments":{}}}',
    }),
    { params: Promise.resolve({ instanceId, name }) },
  );

  it('轉送給創作者並附上可驗證的通行證；不轉 cookie；記錄用量', async () => {
    const h = await hired();
    const res = await call(h.instanceId, 'fin', signProjectToken(h.projectId, 'test-secret'));
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
    const token = signProjectToken(h.projectId, 'test-secret');
    expect((await call(h.instanceId, 'fin')).status).toBe(401);
    expect((await call(other.instanceId, 'fin', token)).status).toBe(403);
    expect((await call(h.instanceId, 'nope', token)).status).toBe(404);

    await db.from('agent_instances').delete().eq('id', h.instanceId);
    expect((await call(h.instanceId, 'fin', token)).status).toBe(404);
  });

  it('公開 JWKS', async () => {
    const res = await jwks(new Request('https://p.test/.well-known/jwks.json'), {});
    expect(await res.json()).toEqual({ keys: [publicJwk(pem)] });
  });
});
