import { createClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTemplate } from '@/lib/services/templates';
import { seedUser, testDb } from './helpers';

const hoisted = vi.hoisted(() => ({
  calls: [] as string[],
  afterTasks: [] as (() => unknown)[],
}));

vi.mock('@/lib/hosted-sprite', () => ({
  createHostedSpriteOps: () => ({
    provision: async () => { hoisted.calls.push('provision'); return { spriteName: 'agenthub-mcp-fake', spriteUrl: 'https://fake.sprites.app' }; },
    readState: async () => { hoisted.calls.push('readState'); return { phase: 'installing', log: 'pip' }; },
    startService: async () => { hoisted.calls.push('startService'); },
    listTools: async () => [],
    serviceLog: async () => '',
    applyEnv: async () => { hoisted.calls.push('applyEnv'); },
    destroy: async () => { hoisted.calls.push('destroy'); },
  }),
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => unknown) => { hoisted.afterTasks.push(fn); },
}));

const { GET: listRoute, POST: createRoute } = await import('@/app/api/templates/[id]/hosted/[mcp]/versions/route');
const { GET: readRoute, DELETE: retireRoute } = await import('@/app/api/templates/[id]/hosted/[mcp]/versions/[versionId]/route');
const { POST: deployRoute } = await import('@/app/api/templates/[id]/hosted/[mcp]/versions/[versionId]/deploy/route');
const { POST: publishRoute } = await import('@/app/api/templates/[id]/hosted/[mcp]/versions/[versionId]/publish/route');
const { PUT: secretsRoute } = await import('@/app/api/templates/[id]/hosted/[mcp]/secrets/route');

const db = testDb();

async function tokenFor(user: { email: string; password: string }) {
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword(user);
  if (error) throw error;
  return data.session!.access_token;
}

const req = (token: string, method = 'GET', body?: unknown) => new Request('https://p.test/api', {
  method,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });

describe('代管 MCP API', () => {
  let creatorToken: string;
  let otherToken: string;
  let templateId: string;

  beforeAll(async () => {
    const creator = await seedUser(db);
    const other = await seedUser(db);
    [creatorToken, otherToken] = await Promise.all([tokenFor(creator), tokenFor(other)]);
    const t = await createTemplate(db, creator.id, {
      name: '代管顧問', description: '', category: '', system_prompt: 'p',
      mcp_servers: [{ name: 'fin', transport: 'remote', hosted: true, required_secrets: [] }],
    });
    templateId = t.id;
  });

  it('沒登入：每個路由都 401', async () => {
    const v = { id: templateId, mcp: 'fin', versionId: '00000000-0000-0000-0000-000000000000' };
    const responses = await Promise.all([
      listRoute(req('bad'), ctx(v)),
      createRoute(req('bad', 'POST'), ctx(v)),
      readRoute(req('bad'), ctx(v)),
      retireRoute(req('bad', 'DELETE'), ctx(v)),
      deployRoute(req('bad', 'POST'), ctx(v)),
      publishRoute(req('bad', 'POST'), ctx(v)),
      secretsRoute(req('bad', 'PUT', { secrets: {} }), ctx(v)),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
  });

  it('建立、上傳、部署（after 裡推進）、讀狀態；別人 404', async () => {
    const p = { id: templateId, mcp: 'fin' };
    expect((await createRoute(req(otherToken, 'POST'), ctx(p))).status).toBe(404);

    const created = await createRoute(req(creatorToken, 'POST'), ctx(p));
    expect(created.status).toBe(200);
    const { version, signedUrl } = await created.json();
    expect(version).toMatchObject({ version: 1, status: 'pending' });
    expect(signedUrl).toMatch(/^https:\/\//);

    const list = await (await listRoute(req(creatorToken), ctx(p))).json();
    expect(list.map((v: { id: string }) => v.id)).toEqual([version.id]);

    const vp = { ...p, versionId: version.id };
    expect((await readRoute(req(otherToken), ctx(vp))).status).toBe(404);
    expect((await readRoute(req(creatorToken), ctx({ ...vp, mcp: 'other' }))).status).toBe(404);
    expect((await publishRoute(req(creatorToken, 'POST'), ctx(vp))).status).toBe(409);

    const zip = new Blob([new Uint8Array([80, 75, 5, 6])]);
    expect((await fetch(signedUrl, { method: 'PUT', body: zip, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } })).ok).toBe(true);
    const deploy = await deployRoute(req(creatorToken, 'POST'), ctx(vp));
    expect((await deploy.json()).status).toBe('deploying');
    expect(hoisted.afterTasks).toHaveLength(1);
    await hoisted.afterTasks[0]();
    expect(hoisted.calls).toEqual(['provision', 'readState']);

    const read = await (await readRoute(req(creatorToken), ctx(vp))).json();
    expect(read).toMatchObject({ status: 'deploying', sprite_name: `agenthub-mcp-${version.id.replace(/-/g, '').slice(0, 12)}`, log_tail: 'pip' });
    expect(hoisted.calls.at(-1)).toBe('readState');
    expect((await retireRoute(req(creatorToken, 'DELETE'), ctx(vp))).status).toBe(409);
  });

  it('金鑰：值必須是字串；別人 404', async () => {
    const p = { id: templateId, mcp: 'fin' };
    expect((await secretsRoute(req(creatorToken, 'PUT', { secrets: { API_KEY: 1 } }), ctx(p))).status).toBe(400);
    expect((await secretsRoute(req(creatorToken, 'PUT', {}), ctx(p))).status).toBe(400);
    expect((await secretsRoute(req(otherToken, 'PUT', { secrets: { API_KEY: 'v' } }), ctx(p))).status).toBe(404);
    const ok = await secretsRoute(req(creatorToken, 'PUT', { secrets: { API_KEY: 'v' } }), ctx(p));
    expect(ok.status).toBe(200);
    const { data } = await db.rpc('get_hosted_mcp_secrets', { p_template_id: templateId, p_mcp_name: 'fin' });
    expect(data).toEqual([{ key: 'API_KEY', value: 'v' }]);
  });
});
