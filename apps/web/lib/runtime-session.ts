import { createHmac, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import type { Db } from '@/lib/supabase/admin';

/**
 * 每個專案一個 Supabase 系統帳號（runtime 帳號）。Vercel 替它取得通行證交給 runtime，
 * runtime 用這張通行證存取資料庫，權限由 RLS 依 app_metadata.agenthub_runtime_project 限定在該專案。
 */
export const RUNTIME_EMAIL_DOMAIN = 'runtime.agenthub.internal';
const MIN_TTL_MS = 20 * 60_000;

type Row = {
  project_id: string;
  user_id: string;
  password: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
};

/** email 帶一段用伺服器金鑰算出的標記：外人知道專案 id 也無法搶先註冊這個 email */
export function runtimeEmail(projectId: string): string {
  const tag = createHmac('sha256', env.supabaseSecretKey).update(`runtime-account:${projectId}`).digest('hex').slice(0, 12);
  return `runtime-${projectId}-${tag}@${RUNTIME_EMAIL_DOMAIN}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isRuntimeAccount(user: { app_metadata?: Record<string, unknown> }): boolean {
  return typeof user.app_metadata?.agenthub_runtime_project === 'string';
}

function authClient() {
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function readRow(db: Db, projectId: string): Promise<Row | null> {
  const { data, error } = await db.from('project_runtime_accounts').select('*').eq('project_id', projectId).maybeSingle();
  if (error) throw error;
  return data as Row | null;
}

async function findUserIdByEmail(db: Db, email: string): Promise<string | null> {
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find((u) => u.email === email);
    if (found) return found.id;
    if (data.users.length < 1000) return null;
  }
}

/** 專案的 runtime 帳號；沒有就建立 */
export async function ensureRuntimeAccount(db: Db, projectId: string): Promise<{ userId: string }> {
  const existing = await readRow(db, projectId);
  if (existing) return { userId: existing.user_id };
  const password = randomBytes(32).toString('base64url');
  const created = await db.auth.admin.createUser({
    email: runtimeEmail(projectId), password, email_confirm: true, app_metadata: { agenthub_runtime_project: projectId },
  });
  let userId: string;
  if (created.error) {
    // 並行建立：另一個請求已建立帳號，等它把密碼寫進表裡再沿用，避免密碼與表不一致
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const row = await readRow(db, projectId);
      if (row) return { userId: row.user_id };
    }
    // 帳號建立了但表沒寫入（例如上次中途失敗）：確認真的是這個專案的 runtime 帳號，才重設密碼後補寫
    const found = await findUserIdByEmail(db, runtimeEmail(projectId));
    if (!found) throw created.error;
    const { data: existingUser } = await db.auth.admin.getUserById(found);
    if (existingUser.user?.app_metadata?.agenthub_runtime_project !== projectId) {
      throw new Error(`runtime 帳號的 email 已被其他帳號使用：${projectId}`);
    }
    const { error } = await db.auth.admin.updateUserById(found, { password });
    if (error) throw error;
    userId = found;
  } else {
    userId = created.data.user.id;
  }
  const { error } = await db.from('project_runtime_accounts')
    .upsert({ project_id: projectId, user_id: userId, password }, { onConflict: 'project_id' });
  if (error) throw error;
  return { userId };
}

async function save(db: Db, projectId: string, s: { access_token: string; refresh_token: string; expires_at?: number }) {
  const { error } = await db.from('project_runtime_accounts')
    .update({
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: new Date((s.expires_at ?? 0) * 1000).toISOString(),
    })
    .eq('project_id', projectId);
  if (error) throw error;
}

/** 這次對話給 runtime 用的資料庫通行證：剩 20 分鐘以上就沿用，否則換新，再不行就重新登入 */
export async function runtimeAccessToken(db: Db, projectId: string, now = Date.now()): Promise<string> {
  await ensureRuntimeAccount(db, projectId);
  const row = (await readRow(db, projectId))!;
  if (row.access_token && row.expires_at && Date.parse(row.expires_at) - now >= MIN_TTL_MS) return row.access_token;
  const auth = authClient().auth;
  if (row.refresh_token) {
    const { data } = await auth.refreshSession({ refresh_token: row.refresh_token });
    if (data.session) {
      await save(db, projectId, data.session);
      return data.session.access_token;
    }
  }
  // email 以帳號實際的為準（不重新計算，伺服器金鑰輪換後仍登得進去）
  const { data: account } = await db.auth.admin.getUserById(row.user_id);
  const email = account.user?.email ?? runtimeEmail(projectId);
  const { data, error } = await auth.signInWithPassword({ email, password: row.password });
  if (error || !data.session) {
    console.error('[runtime-session] 無法取得通行證', projectId, error?.message);
    throw new HttpError(503, 'agent 環境暫時無法連線資料庫，請稍後再試');
  }
  await save(db, projectId, data.session);
  return data.session.access_token;
}

export async function deleteRuntimeAccount(db: Db, projectId: string): Promise<void> {
  const row = await readRow(db, projectId);
  if (!row) return;
  const { error } = await db.auth.admin.deleteUser(row.user_id);
  if (error && error.status !== 404) throw error;
}

/** 專案已不存在（例如擁有者帳號被刪）但 runtime 帳號還在的，一併刪除 */
export async function cleanupOrphanRuntimeAccounts(db: Db): Promise<number> {
  let removed = 0;
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const runtimeUsers = data.users.filter((u) => isRuntimeAccount(u));
    if (runtimeUsers.length > 0) {
      const ids = runtimeUsers.map((u) => u.app_metadata.agenthub_runtime_project as string);
      const { data: alive, error: aliveError } = await db.from('projects').select('id').in('id', ids);
      if (aliveError) throw aliveError;
      const aliveIds = new Set((alive ?? []).map((p) => p.id as string));
      for (const u of runtimeUsers) {
        if (aliveIds.has(u.app_metadata.agenthub_runtime_project as string)) continue;
        const { error: delError } = await db.auth.admin.deleteUser(u.id);
        if (delError && delError.status !== 404) throw delError;
        removed++;
      }
    }
    if (data.users.length < 1000) return removed;
  }
}
