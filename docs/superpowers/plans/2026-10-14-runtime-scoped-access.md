# runtime 只限自己專案的資料庫權限（1-C）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sprite 上不再放 `SUPABASE_SECRET_KEY` 與 Vertex 金鑰。runtime 改用專案專用 Supabase 帳號的通行證連資料庫，權限由 RLS 依權限表把關；模型改走 Vercel 代理。

**Architecture:**
- Vercel 在轉送對話時取得（或換新）該專案 runtime 帳號的 Supabase 通行證，放在 `x-agenthub-db-token` 交給 runtime。
- runtime 以「publishable key + 通行證」建立每次 run 專用的 client。
- 資料庫以 `runtime_project()`（讀通行證的 `app_metadata`）搭配欄位層級 grant 與 policy 限制權限。
- 模型請求送到 Vercel 的 `/api/runtime/model`，由 Vercel 驗證專案通行證後補上 Vertex 金鑰轉送。

**Tech Stack:** Supabase（Auth admin API、RLS、Storage policy）、Next.js 16 route handlers、Hono runtime、AI SDK `@ai-sdk/google-vertex`（express mode）、Vitest、本機 PG16（migration 驗證）。

**Spec:** `docs/superpowers/specs/2026-10-14-runtime-scoped-access-design.md`

## Global Constraints

- runtime 帳號：
  - email `runtime-<專案 id>@runtime.agenthub.internal`
  - `app_metadata.agenthub_runtime_project = <專案 id>`
  - 密碼 32 bytes 隨機（base64url）
  - `email_confirm: true`
- 通行證快取表 `project_runtime_accounts`：只有 service role 讀寫（RLS 開、無 policy、revoke anon/authenticated）。
- 沿用門檻：剩餘效期 ≥ 20 分鐘（`MIN_TTL_MS = 20 * 60_000`）。
- runtime 收到的標頭：`x-agenthub-db-token`（資料庫通行證）、`x-agenthub-token`（3a 的專案通行證，也用於模型代理）。
- 模型代理：`/api/runtime/model/<path>`，runtime 端 `createVertex({ apiKey: <專案通行證>, baseURL: \`${PLATFORM_URL}/api/runtime/model\` })`（express mode 把 apiKey 放在 `x-goog-api-key`）；代理轉送到 `https://aiplatform.googleapis.com/v1/publishers/google/<path>`。
- 權限表以 spec 第 3.2 節為準；每個欄位清單都要對照 runtime 實際查詢。
- `corepack pnpm`；Windows 既有 runtime 基準失敗 6 個（`.superpowers/sdd/<plan>/baseline-fails.txt` 沿用 3a 的清單）。
- 每個 Task 完成就在本機 commit。migration 套用、push、`publish-runtime`、`redeploy-runtime` 是對外動作，執行前先告知使用者；使用者已說可以部署、commit、push。

## Review Focus

1. 一般使用者的通行證（沒有 runtime 標記）對任何表、Storage、`get_project_secrets` 都必須拿不到東西。→ Task 1 SQL 驗證、Task 3 權限測試。
2. 新舊版本並存期間（web 先上、runtime 後上、`.env` 最後才移除金鑰）任何順序都不能讓對話中斷。→ Task 8 的部署順序與每步檢查。
3. 同一專案兩個對話同時需要換新通行證時，兩個都要能拿到可用的 token。→ Task 2 測試並行呼叫。
4. runtime 程序重啟後，遺留的 running run 要在下一次對話開始時被清掉，否則同一串對話會一直回 409。→ Task 5 測試。
5. runtime 帳號的通行證被拿去呼叫網站 API 必須 401。→ Task 3 測試。

---

## 檔案結構

```text
supabase/migrations/20261014000002_runtime_scoped_access.sql   函式、grant、policy、Storage policy、快取表
supabase/tests/runtime_access.sql                              純 SQL 斷言（可在本機 PG 或 Dashboard 執行，最後 rollback）
apps/web/lib/runtime-session.ts       ensureRuntimeAccount、runtimeAccessToken、deleteRuntimeAccount、cleanupOrphanRuntimeAccounts、isRuntimeAccount
apps/web/lib/auth.ts                  currentUser 拒絕 runtime 帳號
apps/web/lib/sprites.ts               forwardChat 帶 dbToken；installRuntime 的 .env（Task 7 才移除金鑰）
apps/web/app/api/threads/[id]/chat/route.ts       取得 db token 並轉送
apps/web/app/api/projects/[id]/route.ts           刪除專案時刪 runtime 帳號
apps/web/app/api/runtime/model/[...path]/route.ts 模型代理
apps/web/test/global-setup.ts         teardown 一併清掉孤兒 runtime 帳號
packages/runtime/src/{config,db,server,run,run-store,main}.ts
packages/runtime/test/{helpers,server,global-setup}.ts、test/runtime-access.test.ts
apps/web/scripts/probe-sandbox.ts     驗收 .env 不含金鑰
docs/security-model.md、CLAUDE.md、README.md
```

---

### Task 0：基準線

- [ ] 分支 `feat/runtime-scoped-access`（已建立，spec 已 commit）。
- [ ] 建 workspace 與 ledger，把 3a 的 `vt.sh`、`baseline-fails.txt` 複製進來。
- [ ] 跑 runtime（`vt.sh @agenthub/runtime`）、web 測試與 typecheck，結果寫進 ledger。

### Task 1：migration 與 SQL 驗證

**Files:** Create `supabase/migrations/20261014000002_runtime_scoped_access.sql`、`supabase/tests/runtime_access.sql`

- [ ] **Step 1：寫驗證 SQL** `supabase/tests/runtime_access.sql`。
  - 整份包在 `begin; … rollback;`。
  - 用 `set local role authenticated` 加 `set local request.jwt.claims = '<json>'` 模擬兩種身分。
  - 以 `do $$ begin assert …; end $$;` 斷言，失敗就丟錯中止。

```sql
begin;
-- 準備資料（以 postgres 身分）
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'creator@test.local'),
  ('00000000-0000-0000-0000-0000000000c2', 'owner@test.local');
insert into public.agent_templates (id, creator_id, name, system_prompt, status)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 't', 'SECRET PROMPT', 'published');
insert into public.projects (id, owner_id, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c2', 'mine'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c2', 'other');
insert into public.agent_instances (id, project_id, template_id, role, name, system_prompt, skills_zip_path) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'consultant', 'x', 'SECRET PROMPT', 'a1/x.zip'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b2', null, 'consultant', 'y', 'OTHER', 'a1/y.zip');
insert into public.threads (id, project_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000b2');
insert into public.runs (id, thread_id, status) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'succeeded');
insert into public.messages (id, thread_id, run_id, kind, content) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'final', 'done');
insert into storage.objects (bucket_id, name) values
  ('skills', 'a1/x.zip'), ('skills', 'a1/y.zip'),
  ('project-files', '00000000-0000-0000-0000-0000000000b1/a.txt'),
  ('project-files', '00000000-0000-0000-0000-0000000000b2/b.txt');

-- runtime 身分（專案 b1）
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"agenthub_runtime_project":"00000000-0000-0000-0000-0000000000b1"}}';
do $$ begin
  assert (select count(*) from public.agent_instances) = 1, 'runtime 只看得到自己專案的顧問';
  assert (select system_prompt from public.agent_instances) = 'SECRET PROMPT', 'runtime 讀得到 system prompt';
  assert (select count(*) from public.agent_templates) = 1, 'runtime 看得到自己顧問的範本';
  assert (select count(*) from public.threads) = 1, 'runtime 只看得到自己專案的對話';
  assert (select array_agg(name order by name) from storage.objects where bucket_id = 'skills') = array['a1/x.zip'], 'runtime 只讀得到自己顧問的 skill zip';
  assert (select array_agg(name order by name) from storage.objects where bucket_id = 'project-files')
         = array['00000000-0000-0000-0000-0000000000b1/a.txt'], 'runtime 只讀得到自己專案的檔案';
end $$;
insert into public.runs (thread_id) values ('00000000-0000-0000-0000-0000000000e1');
do $$ begin
  begin
    insert into public.runs (thread_id) values ('00000000-0000-0000-0000-0000000000e2');
    assert false, '不能替別的專案建立 run';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    perform system_prompt from public.agent_templates;
    assert false, '不能讀範本的 system prompt';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.usage_events;
    assert false, '不能讀用量帳本';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.projects;
    assert false, '不能讀專案表';
  exception when insufficient_privilege then null;
  end;
end $$;
-- 已結束 run 的 final 改不了、刪不了
update public.messages set content = 'hacked' where id = '00000000-0000-0000-0000-000000000011';
delete from public.messages where id = '00000000-0000-0000-0000-000000000011';
do $$ begin
  assert (select content from public.messages where id = '00000000-0000-0000-0000-000000000011') = 'done', '已結束的回覆不能被改或刪';
end $$;
insert into public.usage_events (project_id, model) values ('00000000-0000-0000-0000-0000000000b1', 'm');
do $$ begin
  assert (select count(*) from public.get_project_secrets('00000000-0000-0000-0000-0000000000b1')) = 0, '可以取自己專案的金鑰（這裡沒有）';
  begin
    perform 1 from public.get_project_secrets('00000000-0000-0000-0000-0000000000b2');
    assert false, '不能取別的專案的金鑰';
  exception when raise_exception then null;
  end;
end $$;

-- 一般使用者身分（專案擁有者本人，沒有 runtime 標記）
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated","app_metadata":{"provider":"email"}}';
do $$ begin
  assert (select count(*) from public.agent_instances) = 0, '一般使用者讀不到顧問（含 system prompt）';
  assert (select count(*) from public.messages) = 0, '一般使用者讀不到訊息';
  assert (select count(*) from storage.objects where bucket_id = 'skills') = 0, '一般使用者讀不到 skill zip';
  begin
    perform 1 from public.get_project_secrets('00000000-0000-0000-0000-0000000000b1');
    assert false, '一般使用者不能取金鑰';
  exception when raise_exception then null;
  end;
end $$;
rollback;
```

- [ ] **Step 2：在本機 PG16 驗證會失敗**（migration 尚未存在）。
  - 沿用 3a 的作法：建一個暫時叢集、加上 Supabase 的替身物件，套用全部 migration 後跑這份 SQL。替身物件包括：
    - 角色 `anon`、`authenticated`、`service_role`
    - `auth.users`（含 `raw_user_meta_data`）
    - `auth.jwt()`：讀 `current_setting('request.jwt.claims', true)`
    - `auth.uid()`
    - `storage.buckets`、`storage.objects(bucket_id, name)`，並開啟 RLS
    - `vault.create_secret`、`vault.decrypted_secrets`
    - 對 `anon, authenticated` 的 default privileges
  - Expected：第一個 assert 失敗。目前沒有 policy，runtime 讀到 0 筆。
- [ ] **Step 3：寫 migration**

```sql
-- 子專案 1-C：runtime 以專案專用帳號的通行證存取資料庫，權限由這裡把關

create function public.runtime_project() returns uuid
language sql stable set search_path = '' as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'agenthub_runtime_project', '')::uuid
$$;

-- 一般登入身分（含使用者本人）預設什麼都不能做；網站一律用 service role
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- runtime 帳號的通行證快取（只有 service role）
create table public.project_runtime_accounts (
  project_id uuid primary key references public.projects (id) on delete cascade,
  user_id uuid not null,
  password text not null,
  access_token text,
  refresh_token text,
  expires_at timestamptz
);
alter table public.project_runtime_accounts enable row level security;

-- agent_instances：讀自己專案
grant select (id, project_id, template_id, role, name, description, system_prompt, skills_zip_path, skills, mcp_servers, created_at)
  on public.agent_instances to authenticated;
create policy runtime_read on public.agent_instances for select to authenticated
  using (project_id = public.runtime_project());

-- agent_templates：只讀 creator_id，且只限自己專案租用的範本
grant select (id, creator_id) on public.agent_templates to authenticated;
create policy runtime_read on public.agent_templates for select to authenticated
  using (id in (select template_id from public.agent_instances where project_id = public.runtime_project()));

-- threads：讀自己專案
grant select (id, project_id) on public.threads to authenticated;
create policy runtime_read on public.threads for select to authenticated
  using (project_id = public.runtime_project());

-- runs：讀、新增；只能改狀態欄位
grant select (id, thread_id, status) on public.runs to authenticated;
grant insert (thread_id) on public.runs to authenticated;
grant update (status, error, finished_at) on public.runs to authenticated;
create policy runtime_read on public.runs for select to authenticated
  using (thread_id in (select id from public.threads where project_id = public.runtime_project()));
create policy runtime_insert on public.runs for insert to authenticated
  with check (thread_id in (select id from public.threads where project_id = public.runtime_project()));
create policy runtime_update on public.runs for update to authenticated
  using (thread_id in (select id from public.threads where project_id = public.runtime_project()))
  with check (thread_id in (select id from public.threads where project_id = public.runtime_project()));

-- messages：讀、新增；只能改／刪執行中 run 的 final
grant select (id, thread_id, run_id, kind, content, created_at) on public.messages to authenticated;
grant insert (thread_id, run_id, speaker_instance_id, kind, round, content, ui_message, tool_events) on public.messages to authenticated;
grant update (content, ui_message, tool_events, updated_at) on public.messages to authenticated;
grant delete on public.messages to authenticated;
create policy runtime_read on public.messages for select to authenticated
  using (thread_id in (select id from public.threads where project_id = public.runtime_project()));
create policy runtime_insert on public.messages for insert to authenticated
  with check (thread_id in (select id from public.threads where project_id = public.runtime_project()));
create policy runtime_update on public.messages for update to authenticated
  using (kind = 'final'
         and thread_id in (select id from public.threads where project_id = public.runtime_project())
         and run_id in (select id from public.runs where status = 'running'));
create policy runtime_delete on public.messages for delete to authenticated
  using (kind = 'final' and content = ''
         and thread_id in (select id from public.threads where project_id = public.runtime_project())
         and run_id in (select id from public.runs where status = 'running'));

-- memories：讀、新增
grant select (id, project_id, instance_id, content, created_at) on public.memories to authenticated;
grant insert (project_id, instance_id, content, created_by_instance_id) on public.memories to authenticated;
create policy runtime_read on public.memories for select to authenticated
  using (project_id = public.runtime_project());
create policy runtime_insert on public.memories for insert to authenticated
  with check (project_id = public.runtime_project());

-- usage_events：只能新增
grant insert (run_id, project_id, instance_id, template_id, creator_id, model, prompt_tokens, output_tokens, cached_tokens, thought_tokens)
  on public.usage_events to authenticated;
create policy runtime_insert on public.usage_events for insert to authenticated
  with check (project_id = public.runtime_project());

-- MCP 金鑰：只能取自己專案
create or replace function public.get_project_secrets(p_project_id uuid)
returns table (instance_id uuid, mcp_name text, key text, value text)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' and p_project_id is distinct from public.runtime_project() then
    raise exception 'not allowed';
  end if;
  return query
    select s.instance_id, s.mcp_name, s.key, d.decrypted_secret
      from public.instance_secrets s
      join public.agent_instances i on i.id = s.instance_id
      join vault.decrypted_secrets d on d.id = s.vault_secret_id
     where i.project_id = p_project_id;
end $$;
revoke execute on function public.get_project_secrets(uuid) from public, anon;
grant execute on function public.get_project_secrets(uuid) to authenticated, service_role;

-- Storage：skill zip 只限自己專案顧問的；專案檔案只限自己專案資料夾
create policy runtime_read_skills on storage.objects for select to authenticated
  using (bucket_id = 'skills'
         and name in (select skills_zip_path from public.agent_instances where project_id = public.runtime_project()));
create policy runtime_read_project_files on storage.objects for select to authenticated
  using (bucket_id = 'project-files' and name like public.runtime_project()::text || '/%');

-- runtime 帳號不建立個人檔案
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.raw_app_meta_data ? 'agenthub_runtime_project' then
    return new;
  end if;
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''));
  return new;
end $$;
```

  - 本機替身的 `auth.role()`：`select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', 'service_role')`。
  - `auth.users` 替身需要 `raw_app_meta_data jsonb`。
- [ ] **Step 4：本機 PG 驗證通過**：全部 migration 都能套用，`runtime_access.sql` 沒有任何 assert 失敗。
- [ ] **Step 5：Commit** — `feat(db): runtime 專案帳號的權限與通行證快取表`
- [ ] **Step 6（對外，告知使用者）**：請使用者在 Dashboard SQL Editor 執行 migration，再執行 `runtime_access.sql`（最後會 rollback）。Expected：`Success`。

### Task 2：runtime 帳號與通行證（web）

**Files:** Create `apps/web/lib/runtime-session.ts`；Test `apps/web/test/runtime-session.test.ts`；Modify `apps/web/test/global-setup.ts`

**Interfaces — Produces:**
- `RUNTIME_EMAIL_DOMAIN = 'runtime.agenthub.internal'`
- `isRuntimeAccount(user: { app_metadata?: Record<string, unknown> }): boolean`
- `ensureRuntimeAccount(db: Db, projectId: string): Promise<{ userId: string }>`
- `runtimeAccessToken(db: Db, projectId: string, now?: number): Promise<string>`
- `deleteRuntimeAccount(db: Db, projectId: string): Promise<void>`
- `cleanupOrphanRuntimeAccounts(db: Db): Promise<number>`

- [ ] **Step 1：寫失敗的測試**（雲端 DB，需要 Task 1 的 migration 已套用）

```ts
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createProject } from '@/lib/services/projects';
import {
  cleanupOrphanRuntimeAccounts, deleteRuntimeAccount, ensureRuntimeAccount, isRuntimeAccount, runtimeAccessToken,
} from '@/lib/runtime-session';
import { seedUser, testDb } from './helpers';

const db = testDb();
const anonFor = (token: string) => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
});

describe('runtime 帳號', () => {
  it('第一次取通行證時建立帳號；通行證帶 runtime 標記，只看得到自己專案', async () => {
    const owner = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    const token = await runtimeAccessToken(db, p.id);
    const { data: user } = await db.auth.getUser(token);
    expect(isRuntimeAccount(user.user!)).toBe(true);
    expect(user.user!.app_metadata.agenthub_runtime_project).toBe(p.id);
    const { data: threads, error } = await anonFor(token).from('threads').select('id');
    expect(error).toBeNull();
    expect(threads).toEqual([]);
  });

  it('剩餘效期夠時沿用同一張；快過期時換新並寫回', async () => {
    const owner = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    const first = await runtimeAccessToken(db, p.id);
    expect(await runtimeAccessToken(db, p.id)).toBe(first);
    const later = Date.now() + 45 * 60_000; // 1 小時效期只剩 15 分鐘
    const renewed = await runtimeAccessToken(db, p.id, later);
    expect(renewed).not.toBe(first);
    const { data } = await db.from('project_runtime_accounts').select('access_token').eq('project_id', p.id).single();
    expect(data!.access_token).toBe(renewed);
  });

  it('refresh token 失效時改用密碼登入', async () => {
    const owner = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    await runtimeAccessToken(db, p.id);
    await db.from('project_runtime_accounts').update({ refresh_token: 'invalid', expires_at: new Date(0).toISOString() }).eq('project_id', p.id);
    const token = await runtimeAccessToken(db, p.id);
    expect((await db.auth.getUser(token)).data.user?.app_metadata.agenthub_runtime_project).toBe(p.id);
  });

  it('同一專案並行取通行證都拿得到可用的 token', async () => {
    const owner = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    await ensureRuntimeAccount(db, p.id);
    const tokens = await Promise.all([runtimeAccessToken(db, p.id), runtimeAccessToken(db, p.id)]);
    for (const t of tokens) expect((await db.auth.getUser(t)).error).toBeNull();
  });

  it('刪除專案的 runtime 帳號；清理孤兒帳號', async () => {
    const owner = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    const { userId } = await ensureRuntimeAccount(db, p.id);
    await deleteRuntimeAccount(db, p.id);
    expect((await db.auth.admin.getUserById(userId)).data.user).toBeNull();

    const q = await createProject(db, owner.id, 'q');
    const orphan = await ensureRuntimeAccount(db, q.id);
    await db.from('projects').delete().eq('id', q.id);
    expect(await cleanupOrphanRuntimeAccounts(db)).toBeGreaterThanOrEqual(1);
    expect((await db.auth.admin.getUserById(orphan.userId)).data.user).toBeNull();
  });
});
```

- [ ] **Step 2：** 確認失敗（模組不存在）。
- [ ] **Step 3：實作** `apps/web/lib/runtime-session.ts`

```ts
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import type { Db } from '@/lib/supabase/admin';

export const RUNTIME_EMAIL_DOMAIN = 'runtime.agenthub.internal';
const MIN_TTL_MS = 20 * 60_000;

type Row = { project_id: string; user_id: string; password: string; access_token: string | null; refresh_token: string | null; expires_at: string | null };

export function isRuntimeAccount(user: { app_metadata?: Record<string, unknown> }): boolean {
  return typeof user.app_metadata?.agenthub_runtime_project === 'string';
}

function authClient() {
  return createClient(env.supabaseUrl, env.supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function readRow(db: Db, projectId: string): Promise<Row | null> {
  const { data, error } = await db.from('project_runtime_accounts').select('*').eq('project_id', projectId).maybeSingle();
  if (error) throw error;
  return data as Row | null;
}

/** 專案的 runtime 帳號；沒有就建立 */
export async function ensureRuntimeAccount(db: Db, projectId: string): Promise<{ userId: string }> {
  const existing = await readRow(db, projectId);
  if (existing) return { userId: existing.user_id };
  const password = randomBytes(32).toString('base64url');
  const email = `runtime-${projectId}@${RUNTIME_EMAIL_DOMAIN}`;
  let userId: string;
  const created = await db.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { agenthub_runtime_project: projectId },
  });
  if (created.error) {
    // 並行建立時另一個請求已建好帳號：沿用它，重設密碼
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = list?.users.find((u) => u.email === email);
    if (!found) throw created.error;
    await db.auth.admin.updateUserById(found.id, { password });
    userId = found.id;
  } else {
    userId = created.data.user.id;
  }
  const { error } = await db.from('project_runtime_accounts')
    .upsert({ project_id: projectId, user_id: userId, password }, { onConflict: 'project_id' });
  if (error) throw error;
  return { userId };
}

async function save(db: Db, projectId: string, s: { access_token: string; refresh_token: string; expires_at?: number }) {
  const expires = new Date((s.expires_at ?? 0) * 1000).toISOString();
  const { error } = await db.from('project_runtime_accounts')
    .update({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: expires })
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
  const { data, error } = await auth.signInWithPassword({ email: `runtime-${projectId}@${RUNTIME_EMAIL_DOMAIN}`, password: row.password });
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

/** 專案已刪除（例如擁有者帳號被刪）但 runtime 帳號還在的，一併刪除 */
export async function cleanupOrphanRuntimeAccounts(db: Db): Promise<number> {
  let removed = 0;
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const runtimeUsers = data.users.filter((u) => isRuntimeAccount(u));
    if (runtimeUsers.length) {
      const ids = runtimeUsers.map((u) => u.app_metadata.agenthub_runtime_project as string);
      const { data: alive } = await db.from('projects').select('id').in('id', ids);
      const aliveIds = new Set((alive ?? []).map((p) => p.id));
      for (const u of runtimeUsers) {
        if (aliveIds.has(u.app_metadata.agenthub_runtime_project as string)) continue;
        await db.auth.admin.deleteUser(u.id);
        removed++;
      }
    }
    if (data.users.length < 1000) return removed;
  }
}
```

  `apps/web/test/global-setup.ts` 的 teardown：刪完 `@test.local` 使用者後，執行同樣的孤兒清理（用 `createClient` 建立的 db 呼叫內嵌版本，避免 import `@/lib`）：列出 `app_metadata.agenthub_runtime_project` 不為空、且對應專案已不存在的使用者，逐一刪除。
- [ ] **Step 4：** 測試通過。
- [ ] **Step 5：Commit** — `feat(web): 專案專用的 runtime 帳號與通行證快取`

### Task 3：網站端接上（登入檢查、轉送、刪除、權限測試）

**Files:** Modify `apps/web/lib/auth.ts`、`apps/web/lib/sprites.ts`（`forwardChat`）、`apps/web/app/api/threads/[id]/chat/route.ts`、`apps/web/app/api/projects/[id]/route.ts`；Test `apps/web/test/sprites.test.ts`、`apps/web/test/runtime-access.test.ts`

- [ ] **Step 1：寫失敗的測試**
  - `sprites.test.ts`：`forwardChat(url, body, { dbToken: 'db1', fetchImpl })` → 請求標頭有 `x-agenthub-db-token: db1`。
  - `runtime-access.test.ts`（雲端 DB，真的通行證）：
    - 建兩個專案，各有一位顧問（`system_prompt` 不同）與一個 thread。runtime 帳號 A 用 `anonFor(tokenA)`：
      - `agent_instances` 只有 A 的一筆，system prompt 讀得到。
      - 對 B 的 thread 新增 run 失敗。
      - 讀 `usage_events`、`projects` 回錯誤（42501）。
      - `rpc('get_project_secrets', { p_project_id: B })` 回錯誤。
      - Storage `skills` 下載自己顧問的 zip 成功，下載 B 的失敗。
      - `project-files` 只列得到 `<A>/` 底下。
    - 擁有者本人登入的通行證（`signInWithPassword` 取得）讀 `agent_instances` 得到 0 筆，下載 skill zip 失敗。
    - `currentUser(new Request(..., { headers: { authorization: 'Bearer ' + tokenA } }))` → `null`；用同一張 token 呼叫 `GET /api/projects` 的 handler → 401。
- [ ] **Step 2：** 確認失敗。
- [ ] **Step 3：實作**
  - `lib/auth.ts`：`currentUser` 取得 `user` 後，`if (user && isRuntimeAccount(user)) return null;`（兩條路徑都要）。
  - `forwardChat` 的 opts 加 `dbToken?: string`，有值時加標頭 `x-agenthub-db-token`。
  - chat route：`const dbToken = await runtimeAccessToken(adminDb(), project.id);`，傳進 `forwardChat`。
  - 專案 DELETE route：`deleteOwnProject` 之前先 `await deleteRuntimeAccount(db, project.id)`。
- [ ] **Step 4：** web 全部測試、typecheck、lint 通過。
- [ ] **Step 5：Commit** — `feat(web): 轉送對話時附上 runtime 的資料庫通行證，網站拒絕 runtime 帳號`

### Task 4：模型代理

**Files:** Create `apps/web/app/api/runtime/model/[...path]/route.ts`；Modify `apps/web/lib/env.ts`；Test `apps/web/test/model-proxy.test.ts`

- [ ] **Step 1：寫失敗的測試**
  - 在本機以 `node:http` 開一個假的 Vertex，記錄收到的 path、query、`x-goog-api-key`，回 SSE。
  - `vi.stubEnv('VERTEX_BASE_URL', <假 Vertex>)`、`VERTEX_API_EXPRESS_MODE_KEY='real-key'`、`RUNTIME_TOKEN_SECRET`（32 字元以上）。
  - 帶正確專案通行證（`x-goog-api-key: signProjectToken(...)`）POST `/api/runtime/model/models/gemini-x:streamGenerateContent?alt=sse`：
    - 回 200，本文原樣串流。
    - 假 Vertex 收到 path `/models/gemini-x:streamGenerateContent`、query `alt=sse`、`x-goog-api-key: real-key`。
    - 沒有收到請求方的 `cookie`。
  - 沒有或錯誤的通行證 → 401；假 Vertex 沒收到請求。
- [ ] **Step 2：** 確認失敗。
- [ ] **Step 3：實作**
  - `env.ts` 加 `get vertexBaseUrl() { return process.env.VERTEX_BASE_URL || 'https://aiplatform.googleapis.com/v1/publishers/google'; }`。
  - route：

```ts
import { env } from '@/lib/env';
import { HttpError, route } from '@/lib/http';
import { verifyProjectToken } from '@/lib/platform-tokens';

export const maxDuration = 300;

type Ctx = { params: Promise<{ path: string[] }> };

/** runtime 的模型請求：驗證專案通行證後補上 Vertex 金鑰轉送；Sprite 上不放 Vertex 金鑰 */
async function handle(req: Request, { params }: Ctx): Promise<Response> {
  const secret = env.runtimeTokenSecret;
  if (!secret) throw new HttpError(503, '平台尚未設定專案通行證');
  const token = req.headers.get('x-goog-api-key');
  if (!token) throw new HttpError(401, '缺少專案通行證');
  const projectId = verifyProjectToken(token, secret);
  const { path } = await params;
  // 路徑原樣接上（模型名稱含冒號，例如 models/gemini-x:streamGenerateContent），但不允許跳出 Vertex 的路徑
  if (path.some((p) => p === '..' || p === '.' || p === '' || p.includes('\\'))) throw new HttpError(400, '路徑不正確');
  const url = new URL(req.url);
  const target = `${env.vertexBaseUrl}/${path.join('/')}${url.search}`;
  const headers = new Headers({ 'x-goog-api-key': env.vertexKey });
  for (const k of ['content-type', 'accept']) {
    const v = req.headers.get(k);
    if (v) headers.set(k, v);
  }
  const started = Date.now();
  const upstream = await fetch(target, { method: req.method, headers, body: req.method === 'GET' ? undefined : await req.text(), signal: req.signal });
  console.log(JSON.stringify({ event: 'model_proxy', project_id: projectId, path: path.join('/'), status: upstream.status, ms: Date.now() - started }));
  const out = new Headers();
  for (const k of ['content-type']) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const POST = route(handle);
```

  - 測試再加一項：路徑含 `..` → 400，假 Vertex 沒收到請求。
- [ ] **Step 4：** 測試、typecheck、lint 通過。
- [ ] **Step 5：Commit** — `feat(web): runtime 的模型請求改由平台代理`

### Task 5：runtime 改用通行證

**Files:** Modify `packages/runtime/src/{config,db,server,run,run-store,main}.ts`、`packages/runtime/test/{helpers,server}.test.ts` 與其他直接用到 `createApp` 的測試

**Interfaces — Produces:**
- `createUserDb(url: string, publishableKey: string, token: string): Db`（db.ts）
- `RunDeps = { openDb: (dbToken: string) => Db; modelFor: (platformToken: string | undefined) => LanguageModel; config: Config; runTimeoutMs?; progressIntervalMs? }`
- `startRun(deps, { threadId, text, platformToken?, dbToken })`
- `failRunningRuns(db, projectId, reason, keep: string[] = [])`

- [ ] **Step 1：寫失敗的測試**（`server.test.ts`）
  - `/chat` 沒有 `x-agenthub-db-token` → 401。
  - `openDb` 收到的就是標頭裡的 token。
  - 遺留 run 的清理：先手動插入同專案另一串對話的 `running` run，再送 `/chat`（帶任意 db token，`openDb` 回傳 service client）→ 那個遺留 run 變成 `failed`，`error` 為「runtime 重啟」，新 run 正常結束。
  - 遺留 run 在同一串對話時，新的 `/chat` 不再回 409。
  - `modelFor` 收到 `x-agenthub-token` 的值。
- [ ] **Step 2：** 確認失敗。
- [ ] **Step 3：實作**
  - `config.ts`：
    - 移除 `SUPABASE_SECRET_KEY`、`VERTEX_API_EXPRESS_MODE_KEY`。
    - 新增 `SUPABASE_PUBLISHABLE_KEY: z.string().min(1)`。
    - `PLATFORM_URL` 改為必填。
    - zod 預設會忽略 `.env` 裡多出的舊變數，並存期間不會出錯。
  - `db.ts`：

```ts
/** runtime 帳號的通行證只用在這次 run；publishable key 是公開的，權限全看通行證 */
export function createUserDb(url: string, publishableKey: string, token: string): Db {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
```

  - `server.ts`：讀 `x-agenthub-db-token`，沒有就回 `c.json({ error: '缺少資料庫通行證' }, 401)`；傳給 `startRun`。
  - `run.ts`：
    - `startRun` 開頭 `const db = deps.openDb(req.dbToken); const model = deps.modelFor(req.platformToken);`。
    - 後續原本用 `deps.db`、`deps.model` 的地方改用 `{ ...deps, db, model }` 組成的內部物件，型別為 `ActiveDeps`（`Omit<RunDeps, 'openDb' | 'modelFor'> & { db: Db; model: LanguageModel }`）。
    - 模組層 `const activeRuns = new Set<string>()`：`createRun` 前呼叫 `failRunningRuns(db, config.PROJECT_ID, 'runtime 重啟', [...activeRuns])`；建立後 `add`，run 結束（`finally`）`delete`。
  - `run-store.ts` 的 `failRunningRuns` 加參數 `keep: string[] = []`，有值時加 `.not('id', 'in', \`(${keep.join(',')})\`)`。
  - `main.ts`：
    - 移除開機時的 DB 連線與清理。
    - `openDb = (t) => createUserDb(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, t)`。
    - `modelFor = (t) => createVertex({ apiKey: t ?? '', baseURL: \`${config.PLATFORM_URL}/api/runtime/model\` })(config.MODEL_ID)`。
  - 測試：
    - `testConfig` 加 `SUPABASE_PUBLISHABLE_KEY: 'test'`、`PLATFORM_URL: 'https://p.test'`，移除兩個舊金鑰。
    - `createApp` 改傳 `{ openDb: () => db, modelFor: () => model, config }`。
    - `post()` helper 預設帶 `x-agenthub-db-token: 'test'`。
- [ ] **Step 4：** `vt.sh @agenthub/runtime`（只剩基準失敗）、typecheck 通過。
- [ ] **Step 5：Commit** — `feat(runtime): 以 runtime 帳號的通行證存取資料庫，模型走平台代理`

### Task 6：runtime 實際權限測試（真的通行證）

**Files:** Create `packages/runtime/test/runtime-access.test.ts`；Modify `packages/runtime/test/helpers.ts`、`packages/runtime/test/global-setup.ts`

- [ ] **Step 1：寫測試**
  - helpers 新增 `runtimeToken(db, projectId)`：以 admin API 建立 `runtime-<id>@runtime.agenthub.internal`（含 `app_metadata`），再用 publishable key 登入，回傳 access token。
  - global-setup 的 `provide` 增加 `supabasePublishableKey`；teardown 刪除這些測試用 runtime 帳號（`app_metadata.agenthub_runtime_project` 對應的專案已不存在者）。
  - 測試建立專案、顧問（含 skill zip）、專案檔案與 thread，用 `createApp({ openDb: (t) => createUserDb(url, publishable, t), modelFor: () => mockModel(toolTurn(寫記憶) + textTurn(...)), config })`，送 `/chat`（帶真的 runtime token）。確認：
    - run `succeeded`。
    - `messages` 有 user 與 final，final 內容正確。
    - `usage_events` 有紀錄、`memories` 有新記憶。
    - skill 已同步到工作目錄，`/shared` 有專案檔案。
  - 同一個 app 用專案 B 的 runtime token 送專案 A 的 thread → 404（`assertThreadInProject` 讀不到）。
- [ ] **Step 2：** 跑測試。若某個查詢被 policy 擋下，回 Task 1 補 grant 或 policy，並在 ledger 記 ruling。Expected：全部通過。
- [ ] **Step 3：Commit** — `test(runtime): 以真的 runtime 通行證跑完整對話`

### Task 7：Sprite 不再放金鑰、驗收腳本、文件

**Files:** Modify `apps/web/lib/sprites.ts`（`installRuntime`）、`apps/web/test/sprites.test.ts`、`apps/web/scripts/probe-sandbox.ts`、`docs/security-model.md`、`CLAUDE.md`、`README.md`

- [ ] **Step 1：測試**：`installRuntime` 寫的 `.env`：
  - 包含 `SUPABASE_PUBLISHABLE_KEY`、`PLATFORM_URL`。
  - **不包含** `SUPABASE_SECRET_KEY`、`VERTEX_API_EXPRESS_MODE_KEY`。
- [ ] **Step 2：** 確認失敗。
- [ ] **Step 3：實作**
  - `.env` 移除兩把金鑰，加入 `SUPABASE_PUBLISHABLE_KEY: env.supabasePublishableKey`。
  - `probe-sandbox.ts` 新增一項檢查：runtime 帳號（`sprite`）讀 `~/agenthub/.env`，不含 `SECRET`、`sb_secret_`、`VERTEX` 字樣。
  - 文件：
    - `security-model.md` 第 4 節改成實際的權限表，狀態改「✅ 1-C」，並註明輪換金鑰待做。
    - CLAUDE.md 架構段落改寫 runtime 的資料庫存取方式。
    - README 環境變數表註明 runtime 的 `.env` 只剩不敏感設定。
- [ ] **Step 4：** web 測試通過。
- [ ] **Step 5：Commit** — `feat(web): Sprite 的設定不再包含平台金鑰`（此 commit 在 Task 8 第二次部署時才 push）

### Task 8：部署（對外，依序執行並逐步確認）

1. 確認 migration 已套用（Task 1 Step 6）。
2. **第一次 web 部署**：push Task 1–6 的 commit（不含 Task 7）。
   - 確認 Vercel 成功，對話照常：此時舊 runtime 仍用 `.env` 的金鑰，忽略新標頭。
   - 確認正式站 `currentUser` 拒絕 runtime 帳號（用驗收腳本取一張 runtime token 呼叫 `/api/projects` → 401）。
3. `publish-runtime`：新專案從此用新 runtime。這時 `.env` 仍含舊金鑰與新的 publishable key，新舊都能跑。
4. **第二次 web 部署**：push Task 7。
5. `redeploy-runtime`：所有 Sprite 換新 runtime 並寫入不含金鑰的 `.env`。逐台確認：
   - health 正常。
   - `.env` 不含金鑰。
   - 用平台驗收腳本（`accept_fintech.py` 一題）確認對話、遠端 MCP、用量都正常。
   - smoke test 通過。
6. `probe-sandbox.ts`：在暫時 Sprite 上全部通過。
7. 後續（不在本計畫執行）：與 Eric 輪換 Supabase secret key 與 Vertex 金鑰，更新 Vercel 與本機 `.env`。
