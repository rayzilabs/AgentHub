import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  cleanupOrphanRuntimeAccounts, deleteRuntimeAccount, ensureRuntimeAccount, isRuntimeAccount, runtimeAccessToken,
} from '@/lib/runtime-session';
import { createProject } from '@/lib/services/projects';
import { seedUser, testDb } from './helpers';

const db = testDb();
const asToken = (token: string) => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
});

async function newProject() {
  const owner = await seedUser(db);
  return createProject(db, owner.id, 'p');
}

describe('runtime 帳號', () => {
  it('第一次取通行證時建立帳號；通行證帶 runtime 標記，只看得到自己專案', async () => {
    const p = await newProject();
    const token = await runtimeAccessToken(db, p.id);
    const { data } = await db.auth.getUser(token);
    expect(isRuntimeAccount(data.user!)).toBe(true);
    expect(data.user!.app_metadata.agenthub_runtime_project).toBe(p.id);
    const { data: threads, error } = await asToken(token).from('threads').select('id');
    expect(error).toBeNull();
    expect(threads).toEqual([]);
  });

  it('剩餘效期夠時沿用同一張；快過期時換新並寫回', async () => {
    const p = await newProject();
    const first = await runtimeAccessToken(db, p.id);
    expect(await runtimeAccessToken(db, p.id)).toBe(first);
    const later = Date.now() + 45 * 60_000; // 1 小時效期只剩約 15 分鐘
    const renewed = await runtimeAccessToken(db, p.id, later);
    expect(renewed).not.toBe(first);
    const { data } = await db.from('project_runtime_accounts').select('access_token').eq('project_id', p.id).single();
    expect(data!.access_token).toBe(renewed);
  });

  it('refresh token 失效時改用密碼登入', async () => {
    const p = await newProject();
    await runtimeAccessToken(db, p.id);
    await db.from('project_runtime_accounts')
      .update({ refresh_token: 'invalid', expires_at: new Date(0).toISOString() })
      .eq('project_id', p.id);
    const token = await runtimeAccessToken(db, p.id);
    expect((await db.auth.getUser(token)).data.user?.app_metadata.agenthub_runtime_project).toBe(p.id);
  });

  it('同一專案並行取通行證，都拿得到可用的 token', async () => {
    const p = await newProject();
    const tokens = await Promise.all([runtimeAccessToken(db, p.id), runtimeAccessToken(db, p.id)]);
    for (const t of tokens) expect((await db.auth.getUser(t)).error).toBeNull();
  });

  it('刪除專案的 runtime 帳號；清理孤兒帳號', async () => {
    const p = await newProject();
    const { userId } = await ensureRuntimeAccount(db, p.id);
    await deleteRuntimeAccount(db, p.id);
    expect((await db.auth.admin.getUserById(userId)).data.user).toBeNull();

    const q = await newProject();
    const orphan = await ensureRuntimeAccount(db, q.id);
    await db.from('projects').delete().eq('id', q.id);
    expect(await cleanupOrphanRuntimeAccounts(db)).toBeGreaterThanOrEqual(1);
    expect((await db.auth.admin.getUserById(orphan.userId)).data.user).toBeNull();
  });

  it('isRuntimeAccount 只認 app_metadata 的標記', () => {
    expect(isRuntimeAccount({ app_metadata: { agenthub_runtime_project: 'x' } })).toBe(true);
    expect(isRuntimeAccount({ app_metadata: { provider: 'email' } })).toBe(false);
    expect(isRuntimeAccount({})).toBe(false);
  });
});
