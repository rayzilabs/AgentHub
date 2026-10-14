import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { signUp } from '@/app/login/actions';
import {
  cleanupOrphanRuntimeAccounts, deleteRuntimeAccount, ensureRuntimeAccount, isRuntimeAccount, runtimeAccessToken, runtimeEmail,
  RUNTIME_EMAIL_DOMAIN,
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

describe('runtime 帳號的 email 不能被搶先註冊', () => {
  const signInAs = async (email: string, password: string) => {
    const auth = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    return (await auth.auth.signInWithPassword({ email, password })).error;
  };

  it('email 帶有外人算不出的標記；有人先註冊「專案 id 的 email」也不影響', async () => {
    const p = await newProject();
    const guessed = `runtime-${p.id}@${RUNTIME_EMAIL_DOMAIN}`;
    const { data: attacker } = await db.auth.admin.createUser({ email: guessed, password: 'attacker-pass-1', email_confirm: true });
    try {
      const token = await runtimeAccessToken(db, p.id);
      const { data } = await db.auth.getUser(token);
      expect(data.user!.email).toBe(runtimeEmail(p.id));
      expect(data.user!.email).not.toBe(guessed);
      expect(await signInAs(guessed, 'attacker-pass-1')).toBeNull(); // 對方的帳號沒被動到
    } finally {
      await db.auth.admin.deleteUser(attacker.user!.id);
    }
  });

  it('同 email 的帳號沒有 runtime 標記時拒絕接管，也不改它的密碼', async () => {
    const p = await newProject();
    const { data: other } = await db.auth.admin.createUser({ email: runtimeEmail(p.id), password: 'someone-else-1', email_confirm: true });
    try {
      await expect(ensureRuntimeAccount(db, p.id)).rejects.toThrow();
      expect(await signInAs(runtimeEmail(p.id), 'someone-else-1')).toBeNull();
    } finally {
      await db.auth.admin.deleteUser(other.user!.id);
    }
  });

  it('網站註冊拒絕 runtime 保留網域', async () => {
    const form = new FormData();
    form.set('email', `x@${RUNTIME_EMAIL_DOMAIN}`);
    form.set('password', 'password-123');
    expect(await signUp({}, form)).toEqual({ error: '這個 Email 網域不能註冊' });
  });
});
