import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { HostedClient } from '@/lib/demo';
import {
  createVersion, listVersions, publishVersion, retireVersion, startDeploy, syncVersion,
  type DeployState, type HostedSpriteOps, type HostedVersion,
} from '@/lib/services/hosted-mcp';
import type { Db } from '@/lib/supabase/admin';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

export function testDb(): Db {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function seedUser(db: Db): Promise<{ id: string; email: string; password: string }> {
  const email = `u-${randomUUID()}@test.local`;
  const password = 'password-123';
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return { id: data.user.id, email, password };
}

export function fakeSprites(state: DeployState = { phase: 'installing', log: 'pip install' }) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ops: HostedSpriteOps & {
    state: DeployState; tools: { name: string; description?: string }[];
    provisionDelayMs: number; provisionError: Error | null; listToolsError: Error | null;
  } = {
    state,
    tools: [{ name: 'rate', description: '匯率' }],
    provisionDelayMs: 0,
    provisionError: null as Error | null,
    listToolsError: null as Error | null,
    async provision(v: HostedVersion, env: Record<string, string>, bundleUrl: string) {
      calls.push({ fn: 'provision', args: [v.id, env, bundleUrl] });
      if (ops.provisionDelayMs) await new Promise((r) => setTimeout(r, ops.provisionDelayMs));
      if (ops.provisionError) throw ops.provisionError;
      return { spriteName: `agenthub-mcp-${v.id.replace(/-/g, '').slice(0, 12)}`, spriteUrl: 'https://fake-mcp.sprites.app' };
    },
    async readState(name: string) { calls.push({ fn: 'readState', args: [name] }); return ops.state; },
    async startService(name: string, start: string) { calls.push({ fn: 'startService', args: [name, start] }); },
    async listTools(url: string, token: string) {
      calls.push({ fn: 'listTools', args: [url, token] });
      if (ops.listToolsError) throw ops.listToolsError;
      return ops.tools;
    },
    async serviceLog(name: string) { calls.push({ fn: 'serviceLog', args: [name] }); return 'ModuleNotFoundError: No module named requests'; },
    async applyEnv(name: string, env: Record<string, string>) { calls.push({ fn: 'applyEnv', args: [name, env] }); },
    async destroy(name: string) { calls.push({ fn: 'destroy', args: [name] }); },
  };
  return { ops, calls };
}

/** 測試用：用 services 加假的 Sprite 操作實作 HostedClient（正式上架走正式站 API） */
export function serviceHostedClient(db: Db, userId: string, sprites: HostedSpriteOps): HostedClient {
  return {
    list: (t, m) => listVersions(db, userId, t, m),
    create: (t, m) => createVersion(db, userId, t, m),
    deploy: async (_t, _m, v) => {
      await startDeploy(db, userId, v);
      return syncVersion(db, v, sprites);
    },
    get: (_t, _m, v) => syncVersion(db, v, sprites),
    publish: (_t, _m, v) => publishVersion(db, userId, v),
    retire: (_t, _m, v) => retireVersion(db, userId, v, sprites),
  };
}
