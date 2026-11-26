import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { vi } from 'vitest';
import type { HostedClient } from '@/lib/demo';
import type { HostName, Liveness, Machine, RuntimeHost, ServiceSpec } from '@/lib/hosts/types';
import {
  createVersion, listVersions, publishVersion, retireVersion, startDeploy, syncVersion,
  type DeployState, type HostedOps, type HostedVersion,
} from '@/lib/services/hosted-mcp';
import type { Db } from '@/lib/supabase/admin';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

export function testDb(): Db {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** 測試用的平台簽章私鑰（ES256，PEM） */
export function testSigningKey(): string {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export async function seedUser(db: Db): Promise<{ id: string; email: string; password: string }> {
  const email = `u-${randomUUID()}@test.local`;
  const password = 'password-123';
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return { id: data.user.id, email, password };
}

/** 假的代管 MCP 操作：provision 依版本的 host 回傳機器（Sprite 名稱＝claim；E2B 是 sandboxId 與通行證） */
export function fakeHostedOps(state: DeployState = { phase: 'installing', log: 'pip install' }) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ops: HostedOps & {
    state: DeployState; tools: { name: string; description?: string }[]; live: Liveness;
    provisionDelayMs: number; provisionError: Error | null; listToolsError: Error | null; extendError: Error | null;
  } = {
    state,
    tools: [{ name: 'rate', description: '匯率' }],
    live: 'running',
    provisionDelayMs: 0,
    provisionError: null,
    listToolsError: null,
    extendError: null,
    async provision(v: HostedVersion, env: Record<string, string>, bundleUrl: string): Promise<Machine> {
      calls.push({ fn: 'provision', args: [v.id, env, bundleUrl] });
      if (ops.provisionDelayMs) await new Promise((r) => setTimeout(r, ops.provisionDelayMs));
      if (ops.provisionError) throw ops.provisionError;
      return v.host === 'e2b'
        ? { host: 'e2b', name: 'sbx-fake', url: 'https://8080-sbx-fake.e2b.app', token: 'fake-traffic-token' }
        : { host: 'sprite', name: `agenthub-mcp-${v.id.replace(/-/g, '').slice(0, 12)}`, url: 'https://fake-mcp.sprites.app', token: null };
    },
    async readState(m: Machine) { calls.push({ fn: 'readState', args: [m] }); return ops.state; },
    async startService(m: Machine, start: string) { calls.push({ fn: 'startService', args: [m, start] }); },
    async listTools(m: Machine, token: string) {
      calls.push({ fn: 'listTools', args: [m, token] });
      if (ops.listToolsError) throw ops.listToolsError;
      return ops.tools;
    },
    async serviceLog(m: Machine) { calls.push({ fn: 'serviceLog', args: [m] }); return 'ModuleNotFoundError: No module named requests'; },
    async applyEnv(m: Machine, env: Record<string, string>) { calls.push({ fn: 'applyEnv', args: [m, env] }); },
    async extend(m: Machine, ms: number) {
      calls.push({ fn: 'extend', args: [m, ms] });
      if (ops.extendError) throw ops.extendError;
      return ops.live;
    },
    async destroy(host: HostName, name: string) { calls.push({ fn: 'destroy', args: [host, name] }); },
  };
  return { ops, calls };
}

/** 測試用：用 services 加假的代管操作實作 HostedClient（正式上架走正式站 API） */
export function serviceHostedClient(db: Db, userId: string, ops: HostedOps): HostedClient {
  return {
    list: (t, m) => listVersions(db, userId, t, m),
    create: (t, m) => createVersion(db, userId, t, m),
    deploy: async (_t, _m, v) => {
      await startDeploy(db, userId, v);
      return syncVersion(db, v, ops);
    },
    get: (_t, _m, v) => syncVersion(db, v, ops),
    publish: (_t, _m, v) => publishVersion(db, userId, v),
    retire: (_t, _m, v) => retireVersion(db, userId, v, ops),
  };
}

/** 假的執行環境：每個方法都是 vi.fn，exec 預設回家目錄 /home/user */
export function fakeRuntimeHost(name: HostName = 'e2b', created?: Machine) {
  return {
    name,
    create: vi.fn(async (): Promise<Machine> => created ?? { host: name, name: 'sbx-new', url: 'https://new.example', token: 'new-tok' }),
    destroy: vi.fn(async () => {}),
    exec: vi.fn(async (_m: Machine, script: string, _opts?: { timeoutMs?: number }): Promise<string> => (script.startsWith('printf %s "$HOME"') ? '/home/user\n' : '')),
    writeFile: vi.fn(async (_m: Machine, _path: string, _content: string) => {}),
    startService: vi.fn(async (_m: Machine, _spec: ServiceSpec) => {}),
    hasService: vi.fn(async () => true),
    restartService: vi.fn(async () => {}),
    serviceLog: vi.fn(async () => ''),
    extend: vi.fn(async (_m: Machine, _ms: number): Promise<Liveness> => 'running'),
    status: vi.fn(async (_m: Machine): Promise<Liveness> => 'running'),
    edgeHeaders: vi.fn((m: Machine): Record<string, string> => (m.host === 'e2b' ? { 'e2b-traffic-access-token': m.token ?? '' } : { authorization: 'Bearer fly' })),
  } satisfies RuntimeHost;
}

/** 讓機器的 /health 回答這個專案；其他請求（Supabase）照常送出。回傳只記錄 /health 的 mock */
export function stubHealth(projectId: string) {
  const realFetch = globalThis.fetch;
  const health = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ project_id: projectId }));
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.endsWith('/health') ? health(url, init) : realFetch(input, init);
  });
  return health;
}
