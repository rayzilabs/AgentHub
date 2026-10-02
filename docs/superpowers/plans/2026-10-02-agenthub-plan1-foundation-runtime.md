# AgentHub 計畫 1：基礎建設 + 單一顧問 runtime 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建好 monorepo、Supabase 資料庫（schema、RPC、Storage bucket），以及可以在本機跟「一位顧問」對話的 agent runtime：串流回覆、執行工具、讀寫記憶、連接 MCP、記錄用量與 run 狀態。

**Architecture:** 資料庫用 Supabase migration 建立，推到雲端 Supabase 開發專案，用 pgTAP 在雲端測試。runtime 是 `packages/runtime` 裡的 Node 服務（Hono），用 Vercel AI SDK v7 的 `ToolLoopAgent` 執行 agent 迴圈，透過 service role key 讀寫 Supabase。回覆以 AI SDK UI message stream 串流；伺服器端用 `tee()` 另外完整讀完串流並寫入資料庫，所以瀏覽器斷線也不影響 run 完成。測試全部用 AI SDK 的 mock 模型，接雲端 Supabase。

**Tech Stack:** pnpm workspace、TypeScript、Supabase CLI（Postgres、Storage、Vault、pgTAP）、`ai` v7、`@ai-sdk/google-vertex`、`@ai-sdk/mcp`、`@supabase/supabase-js`、Hono、zod 4、fflate、Vitest 5。

**Spec:** `docs/superpowers/specs/2026-10-02-agenthub-mvp-design.md`

**本計畫的範圍：** 規格 §2（runtime 與 Supabase 部分）、§3、§5.4（Sprite runtime 那一側）、§6（顧問部分）、§7、§8 的對應項目。多 agent（主管、派工、討論）是計畫 2；Vercel 與前端是計畫 3；部署與冒煙測試是計畫 4。本計畫結束時，專案裡如果有 2 位以上顧問，runtime 會回傳明確錯誤「多顧問模式尚未實作」，由計畫 2 取代。

## Global Constraints

- 開發環境 Node.js 24（`@fly/sprites` 需要 Node 24，計畫 3 會用到）；runtime 套件 `engines.node` 為 `>=22`。
- 套件管理：pnpm 10，workspace 結構 `apps/*`、`packages/*`。
- **不用本機 Supabase container。** repo 已用 Supabase CLI 連結雲端專案 AgentHub（ref `xrcyllzqionkwareukif`）。所有 supabase 指令都在 repo 根目錄執行並加 `--linked`：`supabase db push --linked`、`supabase test db --linked`；migration 需要重來時用 `supabase db reset --linked`（這個開發專案允許重置）。**不可對其他 Supabase 專案下任何指令。**
- 憑證在 repo 根目錄的 `.env`（不可 commit、不可印出值）：`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY`、`FLY_SPRITES_TOKEN`、`VERTEX_API_EXPRESS_MODE_KEY`。測試從這個檔案讀取連線資訊。
- 套件版本下限：`ai@^7.0.126`、`@ai-sdk/google-vertex@^5.0.101`、`@ai-sdk/mcp@^2.0.65`、`@supabase/supabase-js@^2.117.2`、`zod@^4`、`vitest@^5`。
- 模型：`gemini-3.8-flash`，用 Vertex express mode：`createVertex({ apiKey: process.env.VERTEX_API_EXPRESS_MODE_KEY })`。
- 測試一律用 `ai/test` 的 `MockLanguageModelV4`，不呼叫真實 Gemini。
- 上限數字（規格 §6.4）：每個 agent 最多 30 步；`bash` 單次 120 秒、輸出 20000 字元；run 最長 15 分鐘；prompt 放最近 50 筆記憶；「工作中」登記有效 5 分鐘、每 2 分鐘更新。
- Storage：bucket `skills`（物件路徑 `<template_id>/<sha256>.zip`，`skills_zip_path` 存的就是這個路徑）、`project-files`（`<project_id>/<檔名>`）、`runtime`。
- `skills` 欄位格式：`[{ name, description, path }]`，`path` 是 skill 資料夾在 zip 內的相對路徑。
- MCP 工具名稱：`<server 名稱>__<工具名稱>`，非 `[A-Za-z0-9_]` 字元換成 `_`，最長 64 字元。
- 所有給使用者或 agent 看的文字用繁體中文。
- AI SDK v7 命名：用 `onStepEnd`／`onEnd`，不用已棄用的 `onStepFinish`／`onFinish`；agent 的系統提示欄位是 `instructions`。

## Review Focus

1. **瀏覽器在 run 進行中斷線**：run 仍要跑完，final message 寫入、run 標成 succeeded。→ Task 10 測試「中途取消讀取串流」。
2. **同一串對話同時送出兩則訊息**：恰好一個成功、另一個得到 409，資料庫不會出現兩個 running 的 run。→ Task 1 pgTAP（唯一索引）、Task 3 並發 `createRun`、Task 10 的 409 測試。
3. **啟用 agent 時漏填必要金鑰**：整筆撤銷，不留下半個 agent 或孤兒金鑰。→ Task 2 pgTAP。
4. **模型中途出錯**：run 標成 failed 並保留錯誤訊息，不會卡在 running；已產生的內容保留。→ Task 10 測試「模型丟錯」。
5. **skill zip 更新或內容異常**：版本改變時舊檔不殘留；zip 內含 `../` 路徑時不會寫到工作目錄外。→ Task 4 測試。

---

## 檔案結構

```
.gitignore
.nvmrc
package.json                      root scripts
pnpm-workspace.yaml
tsconfig.base.json
supabase/
  config.toml                     supabase init 產生
  migrations/
    20261002000001_init.sql       資料表、RLS、trigger、bucket
    20261002000002_hire_agent.sql hire_agent、get_project_secrets
  tests/
    schema.test.sql
    hire_agent.test.sql
packages/runtime/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    config.ts         環境變數 → Config
    db.ts             Supabase client
    types.ts          資料列型別
    errors.ts         錯誤類別與 errorText()
    run-store.ts      threads / runs / messages
    project-store.ts  agent_instances / secrets
    sync.ts           skills、/shared 同步
    tools/bash.ts
    tools/files.ts
    tools/memory.ts
    mcp.ts
    usage.ts
    keepalive.ts
    agents/prompts.ts
    agents/build.ts
    run.ts            一次 run 的完整流程
    server.ts         Hono app
    main.ts           程式進入點
  test/
    global-setup.ts   從 supabase status 取得連線資訊
    helpers.ts        建測試資料
    mock-model.ts     mock 模型
    fixtures/echo-mcp.mjs  最小 stdio MCP server
    *.test.ts
```

---

### Task 1: Monorepo 骨架與資料庫 schema

**Files:**
- Create: `.gitignore`、`.nvmrc`、`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`
- Create: `supabase/config.toml`（由 `supabase init` 產生）
- Create: `supabase/migrations/20261002000001_init.sql`
- Test: `supabase/tests/schema.test.sql`

**Interfaces:**
- Consumes: 無
- Produces: 資料表 `profiles`、`agent_templates`、`projects`、`agent_instances`、`instance_secrets`、`threads`、`runs`、`messages`、`memories`、`usage_events`；唯一索引 `one_running_run_per_thread`、`one_manager_per_project`；bucket `skills`、`project-files`、`runtime`。欄位名稱以本 Task 的 SQL 為準，後續 Task 直接引用。

- [ ] **Step 1: 建立 repo 與 workspace 設定**

repo 已經是 git repo，也已連結雲端 Supabase（`supabase/.temp/` 已存在）。只需要產生 `supabase/config.toml`：

```bash
cd /Users/eric/Desktop/AgentHub
supabase init --force
```

若詢問是否產生 VS Code / IntelliJ 設定，都選 No（或加 `--with-vscode-settings=false --with-intellij-settings=false`）。

建立 `.gitignore`：

```gitignore
node_modules/
dist/
.env
.env.*
!.env.example
supabase/.temp/
supabase/.branches/
```

建立 `.nvmrc`：

```
24
```

建立 `package.json`：

```json
{
  "name": "agenthub",
  "private": true,
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "db:push": "supabase db push --linked --yes",
    "db:test": "supabase test db --linked"
  }
}
```

建立 `pnpm-workspace.yaml`：

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

建立 `tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

- [ ] **Step 2: 寫 schema 測試**

建立 `supabase/tests/schema.test.sql`：

```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

select ok(
  (select bool_and(c.relrowsecurity)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'),
  'public 底下所有資料表都開啟 RLS');

select is(
  (select count(*)::int from pg_policies where schemaname = 'public'),
  0,
  'public 沒有任何 RLS 規則（一律拒絕直接存取）');

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

select is(
  (select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'),
  1,
  '新使用者自動建立 profile');

insert into public.projects (id, owner_id, name)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'p');
insert into public.threads (id, project_id)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1');
insert into public.runs (thread_id) values ('00000000-0000-0000-0000-0000000000c1');

select throws_ok(
  $$ insert into public.runs (thread_id) values ('00000000-0000-0000-0000-0000000000c1') $$,
  '23505',
  null,
  '同一串對話不能同時有兩個 running 的 run');

select results_eq(
  $$ select id from storage.buckets where id in ('skills', 'project-files', 'runtime') order by id $$,
  $$ values ('project-files'::text), ('runtime'::text), ('skills'::text) $$,
  '三個 Storage bucket 都存在');

select * from finish();
rollback;
```

- [ ] **Step 3: 確認測試失敗**

```bash
supabase test db --linked
```

Expected: FAIL，錯誤類似 `relation "public.profiles" does not exist`。

- [ ] **Step 4: 寫 migration**

建立 `supabase/migrations/20261002000001_init.sql`：

```sql
-- 使用者
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 創作者上架的範本
create table public.agent_templates (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  description text not null default '',
  category text not null default '',
  system_prompt text not null default '',
  skills_zip_path text,
  skills jsonb not null default '[]'::jsonb,
  mcp_servers jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 專案（一個專案一台 Sprite）
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  sprite_name text,
  sprite_url text,
  sprite_status text not null default 'provisioning'
    check (sprite_status in ('provisioning', 'ready', 'error')),
  sprite_error text,
  created_at timestamptz not null default now()
);

-- 專案裡的 agent（啟用當下的快照）
create table public.agent_instances (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  template_id uuid references public.agent_templates (id) on delete set null,
  role text not null check (role in ('consultant', 'manager')),
  name text not null,
  system_prompt text not null default '',
  skills_zip_path text,
  skills jsonb not null default '[]'::jsonb,
  mcp_servers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create unique index one_manager_per_project
  on public.agent_instances (project_id) where role = 'manager';

-- 租用者填的 MCP 金鑰（實際值在 Vault）
create table public.instance_secrets (
  instance_id uuid not null references public.agent_instances (id) on delete cascade,
  mcp_name text not null,
  key text not null,
  vault_secret_id uuid not null,
  primary key (instance_id, mcp_name, key)
);

-- 對話
create table public.threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null default '新對話',
  created_at timestamptz not null default now()
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index one_running_run_per_thread
  on public.runs (thread_id) where status = 'running';

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  run_id uuid references public.runs (id) on delete cascade,
  speaker_instance_id uuid references public.agent_instances (id) on delete set null,
  kind text not null check (kind in ('user', 'final', 'delegation', 'discussion')),
  round int,
  content text not null default '',
  ui_message jsonb,
  tool_events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index messages_thread_created on public.messages (thread_id, created_at);

-- 記憶：instance_id 為 null 代表專案共用
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  instance_id uuid references public.agent_instances (id) on delete cascade,
  content text not null,
  created_by_instance_id uuid references public.agent_instances (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index memories_project_created on public.memories (project_id, created_at desc);

-- 用量帳本：刻意不加外鍵，專案或 agent 刪除後帳本仍保留
create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid,
  project_id uuid not null,
  instance_id uuid,
  template_id uuid,
  creator_id uuid,
  model text not null,
  prompt_tokens int not null default 0,
  output_tokens int not null default 0,
  cached_tokens int not null default 0,
  thought_tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index usage_events_creator_created on public.usage_events (creator_id, created_at);

-- 全部開 RLS、不設規則：只有 service role 能讀寫
alter table public.profiles enable row level security;
alter table public.agent_templates enable row level security;
alter table public.projects enable row level security;
alter table public.agent_instances enable row level security;
alter table public.instance_secrets enable row level security;
alter table public.threads enable row level security;
alter table public.runs enable row level security;
alter table public.messages enable row level security;
alter table public.memories enable row level security;
alter table public.usage_events enable row level security;

-- Storage buckets（私有）
insert into storage.buckets (id, name, public) values
  ('skills', 'skills', false),
  ('project-files', 'project-files', false),
  ('runtime', 'runtime', false)
on conflict (id) do nothing;
```

- [ ] **Step 5: 套用 migration 並確認測試通過**

```bash
supabase db push --linked --yes
supabase test db --linked
```

Expected: `schema.test.sql .. ok`，`All tests successful.`

- [ ] **Step 6: Commit**

```bash
git add .gitignore .nvmrc package.json pnpm-workspace.yaml tsconfig.base.json supabase/
git commit -m "feat: monorepo 骨架與資料庫 schema"
```

---

### Task 2: `hire_agent` 與 `get_project_secrets` RPC

**Files:**
- Create: `supabase/migrations/20261002000002_hire_agent.sql`
- Test: `supabase/tests/hire_agent.test.sql`

**Interfaces:**
- Consumes: Task 1 的資料表。
- Produces:
  - `public.hire_agent(p_project_id uuid, p_template_id uuid, p_secrets jsonb default '{}') returns uuid`：回傳新 `agent_instances.id`。`p_secrets` 格式為 `{ "<mcp 名稱>": { "<金鑰名稱>": "<值>" } }`。缺必要金鑰時丟 `22023`，訊息 `missing secret <mcp>.<key>`；範本不存在或不是 published 時丟 `P0002`。
  - `public.get_project_secrets(p_project_id uuid) returns table (instance_id uuid, mcp_name text, key text, value text)`。
  - 兩個函式只有 `service_role` 能執行。

- [ ] **Step 1: 寫測試**

建立 `supabase/tests/hire_agent.test.sql`：

```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'creator@test.local'),
  ('00000000-0000-0000-0000-000000000002', 'renter@test.local');

insert into public.agent_templates (id, creator_id, name, system_prompt, skills_zip_path, skills, mcp_servers, status) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001',
   '法務顧問', '你是法務', 'a1/abc.zip',
   '[{"name":"contract","description":"審合約","path":"contract"}]',
   '[{"name":"finmind","transport":"stdio","command":"npx","args":["finmind-mcp"],"required_secrets":[{"key":"FINMIND_API_KEY","description":"FinMind token"}]}]',
   'published'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001',
   '財務顧問', '你是財務', null, '[]', '[]', 'published'),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000001',
   '草稿', '', null, '[]', '[]', 'draft');

insert into public.projects (id, owner_id, name)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000002', 'demo');

-- 缺金鑰：整筆撤銷
select throws_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', '{}'::jsonb) $$,
  '22023',
  'missing secret finmind.FINMIND_API_KEY',
  '缺必要金鑰時拒絕');
select is(
  (select count(*)::int from public.agent_instances where project_id = '00000000-0000-0000-0000-0000000000b1'),
  0,
  '缺金鑰時不留下任何 agent');

-- 草稿範本不能啟用
select throws_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a3', '{}'::jsonb) $$,
  'P0002',
  null,
  '草稿範本不能啟用');

-- 成功啟用：複製快照、存金鑰
select lives_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
       '{"finmind":{"FINMIND_API_KEY":"k-123"}}'::jsonb) $$,
  '填好金鑰後可以啟用');
select results_eq(
  $$ select name, system_prompt, skills_zip_path, role from public.agent_instances
     where project_id = '00000000-0000-0000-0000-0000000000b1' $$,
  $$ values ('法務顧問'::text, '你是法務'::text, 'a1/abc.zip'::text, 'consultant'::text) $$,
  '從範本複製快照');
select is(
  (select value from public.get_project_secrets('00000000-0000-0000-0000-0000000000b1')),
  'k-123',
  '金鑰可以透過 get_project_secrets 讀回');
select is(
  (select count(*)::int from public.agent_instances
    where project_id = '00000000-0000-0000-0000-0000000000b1' and role = 'manager'),
  0,
  '只有 1 位顧問時沒有主管');

-- 第 2 位顧問：自動建立主管
select lives_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', '{}'::jsonb) $$,
  '啟用第 2 位顧問');
select is(
  (select count(*)::int from public.agent_instances
    where project_id = '00000000-0000-0000-0000-0000000000b1' and role = 'manager'),
  1,
  '第 2 位顧問加入時自動建立主管');

-- 第 3 位顧問：主管仍只有一位
select lives_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', '{}'::jsonb) $$,
  '啟用第 3 位顧問');
select is(
  (select count(*)::int from public.agent_instances
    where project_id = '00000000-0000-0000-0000-0000000000b1' and role = 'manager'),
  1,
  '主管只會有一位');

-- 快照不受範本修改影響
update public.agent_templates set system_prompt = '改過' where id = '00000000-0000-0000-0000-0000000000a1';
select is(
  (select system_prompt from public.agent_instances where template_id = '00000000-0000-0000-0000-0000000000a1'),
  '你是法務',
  '修改範本不影響已啟用的 agent');

-- 權限
select ok(
  not has_function_privilege('anon', 'public.hire_agent(uuid, uuid, jsonb)', 'execute'),
  'anon 不能執行 hire_agent');
select ok(
  not has_function_privilege('authenticated', 'public.get_project_secrets(uuid)', 'execute'),
  'authenticated 不能執行 get_project_secrets');

select * from finish();
rollback;
```

- [ ] **Step 2: 確認測試失敗**

```bash
supabase test db --linked
```

Expected: `hire_agent.test.sql` FAIL，錯誤類似 `function public.hire_agent(uuid, uuid, jsonb) does not exist`。

- [ ] **Step 3: 寫 migration**

建立 `supabase/migrations/20261002000002_hire_agent.sql`：

```sql
create function public.hire_agent(p_project_id uuid, p_template_id uuid, p_secrets jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.agent_templates%rowtype;
  v_instance_id uuid;
  v_server jsonb;
  v_required jsonb;
  v_value text;
  v_secret_id uuid;
  v_consultants int;
begin
  select * into t from public.agent_templates
   where id = p_template_id and status = 'published';
  if not found then
    raise exception 'template % not found or not published', p_template_id using errcode = 'P0002';
  end if;

  insert into public.agent_instances
    (project_id, template_id, role, name, system_prompt, skills_zip_path, skills, mcp_servers)
  values
    (p_project_id, t.id, 'consultant', t.name, t.system_prompt, t.skills_zip_path, t.skills, t.mcp_servers)
  returning id into v_instance_id;

  for v_server in select * from jsonb_array_elements(t.mcp_servers) loop
    for v_required in select * from jsonb_array_elements(coalesce(v_server -> 'required_secrets', '[]'::jsonb)) loop
      v_value := p_secrets -> (v_server ->> 'name') ->> (v_required ->> 'key');
      if v_value is null or v_value = '' then
        raise exception 'missing secret %.%', v_server ->> 'name', v_required ->> 'key' using errcode = '22023';
      end if;
      v_secret_id := vault.create_secret(
        v_value,
        v_instance_id::text || ':' || (v_server ->> 'name') || ':' || (v_required ->> 'key'));
      insert into public.instance_secrets (instance_id, mcp_name, key, vault_secret_id)
      values (v_instance_id, v_server ->> 'name', v_required ->> 'key', v_secret_id);
    end loop;
  end loop;

  select count(*) into v_consultants
    from public.agent_instances
   where project_id = p_project_id and role = 'consultant';
  if v_consultants >= 2 then
    insert into public.agent_instances (project_id, role, name)
    values (p_project_id, 'manager', '主管')
    on conflict (project_id) where role = 'manager' do nothing;
  end if;

  return v_instance_id;
end $$;

create function public.get_project_secrets(p_project_id uuid)
returns table (instance_id uuid, mcp_name text, key text, value text)
language sql security definer set search_path = '' as $$
  select s.instance_id, s.mcp_name, s.key, d.decrypted_secret
    from public.instance_secrets s
    join public.agent_instances i on i.id = s.instance_id
    join vault.decrypted_secrets d on d.id = s.vault_secret_id
   where i.project_id = p_project_id
$$;

-- 新函式預設 PUBLIC 可執行，Supabase 也預設授權給 anon / authenticated，必須全部收回
revoke execute on function public.hire_agent(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.get_project_secrets(uuid) from public, anon, authenticated;
grant execute on function public.hire_agent(uuid, uuid, jsonb) to service_role;
grant execute on function public.get_project_secrets(uuid) to service_role;
```

- [ ] **Step 4: 確認測試通過**

```bash
supabase db push --linked --yes
supabase test db --linked
```

Expected: `schema.test.sql .. ok`、`hire_agent.test.sql .. ok`、`All tests successful.`

- [ ] **Step 5: Commit**

```bash
git add supabase/
git commit -m "feat: hire_agent 與 get_project_secrets RPC"
```

---

### Task 3: runtime 套件骨架與資料存取層

**Files:**
- Create: `packages/runtime/package.json`、`packages/runtime/tsconfig.json`、`packages/runtime/vitest.config.ts`
- Create: `packages/runtime/src/config.ts`、`src/db.ts`、`src/types.ts`、`src/errors.ts`、`src/run-store.ts`、`src/project-store.ts`
- Create: `packages/runtime/test/global-setup.ts`、`test/helpers.ts`
- Test: `packages/runtime/test/run-store.test.ts`、`test/project-store.test.ts`

**Interfaces:**
- Consumes: Task 1 資料表、Task 2 的 `get_project_secrets`。
- Produces（後續 Task 都會用）：
  - `loadConfig(env?: NodeJS.ProcessEnv): Config`；`Config` 欄位：`PROJECT_ID`、`SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`VERTEX_API_EXPRESS_MODE_KEY`、`AGENTS_ROOT`、`SHARED_ROOT`、`SPRITE_API_SOCK`、`MODEL_ID`、`PORT`
  - `createDb(url: string, serviceKey: string): Db`
  - 型別 `SkillMeta`、`McpServerConfig`、`AgentInstance`（含 `creator_id: string | null`）、`SecretRow`、`MessageKind`
  - `RunConflictError`、`NotFoundError`、`SyncError`、`errorText(e: unknown): string`
  - `assertThreadInProject(db, threadId, projectId): Promise<void>`
  - `createRun(db, threadId): Promise<string>`
  - `finishRun(db, runId, result: RunResult): Promise<void>`；`RunResult = { status: 'succeeded' } | { status: 'failed'; error: string }`
  - `insertMessage(db, m: NewMessage): Promise<string>`
  - `loadHistory(db, threadId, limit?: number): Promise<ModelMessage[]>`
  - `failRunningRuns(db, projectId, reason): Promise<number>`
  - `loadInstances(db, projectId): Promise<AgentInstance[]>`
  - `loadSecrets(db, projectId): Promise<SecretRow[]>`
  - `groupSecrets(rows: SecretRow[], instanceId: string): Record<string, Record<string, string>>`
  - 測試工具：`testDb()`、`seedUser`、`seedTemplate`、`seedProject`、`seedThread`、`seedConsultant`、`uploadSkillsZip`、`tmpRoots`、`testConfig`、`waitFor`

- [ ] **Step 1: 建立套件並安裝依賴**

建立 `packages/runtime/package.json`：

```json
{
  "name": "@agenthub/runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

```bash
cd packages/runtime
pnpm add ai@^7.0.126 @ai-sdk/google-vertex@^5.0.101 @ai-sdk/mcp@^2.0.65 @supabase/supabase-js@^2.117.2 hono @hono/node-server zod@^4 fflate
pnpm add -D vitest@^5 typescript @types/node@^24 tsx
cd ../..
```

建立 `packages/runtime/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

建立 `packages/runtime/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 2: 建立設定、型別、錯誤、DB client**

建立 `packages/runtime/src/config.ts`：

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  PROJECT_ID: z.uuid(),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  VERTEX_API_EXPRESS_MODE_KEY: z.string().min(1),
  AGENTS_ROOT: z.string().default('/agents'),
  SHARED_ROOT: z.string().default('/shared'),
  SPRITE_API_SOCK: z.string().default('/.sprite/api.sock'),
  MODEL_ID: z.string().default('gemini-3.8-flash'),
  PORT: z.coerce.number().int().default(8080),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}
```

建立 `packages/runtime/src/db.ts`：

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Db = SupabaseClient;

export function createDb(url: string, serviceKey: string): Db {
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

建立 `packages/runtime/src/types.ts`：

```ts
export type SkillMeta = { name: string; description: string; path: string };

export type McpServerConfig = {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  required_secrets?: { key: string; description?: string }[];
};

export type AgentInstance = {
  id: string;
  project_id: string;
  template_id: string | null;
  creator_id: string | null;
  role: 'consultant' | 'manager';
  name: string;
  system_prompt: string;
  skills_zip_path: string | null;
  skills: SkillMeta[];
  mcp_servers: McpServerConfig[];
};

export type SecretRow = { instance_id: string; mcp_name: string; key: string; value: string };

export type MessageKind = 'user' | 'final' | 'delegation' | 'discussion';
```

建立 `packages/runtime/src/errors.ts`：

```ts
export class RunConflictError extends Error {}
export class NotFoundError extends Error {}
export class SyncError extends Error {}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
```

- [ ] **Step 3: 建立測試基礎設施**

建立 `packages/runtime/test/global-setup.ts`：

測試接雲端 Supabase：從 repo 根目錄的 `.env` 讀連線資訊；全部測試跑完後，刪掉所有 `@test.local` 的測試帳號（會連帶刪掉他們的專案、範本等資料）。

```ts
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    supabaseUrl: string;
    supabaseServiceKey: string;
  }
}

export default function setup(project: TestProject) {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  project.provide('supabaseUrl', url);
  project.provide('supabaseServiceKey', key);

  return async () => {
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    for (;;) {
      const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      const testUsers = data.users.filter((u) => u.email?.endsWith('@test.local'));
      if (testUsers.length === 0) break;
      await Promise.all(testUsers.map((u) => db.auth.admin.deleteUser(u.id)));
    }
  };
}
```

建立 `packages/runtime/test/helpers.ts`：

```ts
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { inject } from 'vitest';
import type { Config } from '../src/config';
import { createDb, type Db } from '../src/db';
import type { McpServerConfig, SkillMeta } from '../src/types';

export function testDb(): Db {
  return createDb(inject('supabaseUrl'), inject('supabaseServiceKey'));
}

export async function seedUser(db: Db): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email: `u-${randomUUID()}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error) throw error;
  return data.user.id;
}

export async function seedTemplate(db: Db, creatorId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await db
    .from('agent_templates')
    .insert({ creator_id: creatorId, name: '測試範本', status: 'published', ...fields })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function seedProject(db: Db, ownerId: string): Promise<string> {
  const { data, error } = await db.from('projects').insert({ owner_id: ownerId, name: '測試專案' }).select('id').single();
  if (error) throw error;
  return data.id;
}

export async function seedThread(db: Db, projectId: string): Promise<string> {
  const { data, error } = await db.from('threads').insert({ project_id: projectId }).select('id').single();
  if (error) throw error;
  return data.id;
}

export type ConsultantFields = {
  template_id?: string | null;
  name?: string;
  system_prompt?: string;
  skills_zip_path?: string | null;
  skills?: SkillMeta[];
  mcp_servers?: McpServerConfig[];
};

export async function seedConsultant(db: Db, projectId: string, fields: ConsultantFields = {}): Promise<string> {
  const { data, error } = await db
    .from('agent_instances')
    .insert({ project_id: projectId, role: 'consultant', name: '法務顧問', system_prompt: '你是法務顧問。', ...fields })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function uploadSkillsZip(db: Db, files: Record<string, string>): Promise<string> {
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
  const sha = createHash('sha256').update(zip).digest('hex');
  const objectPath = `${randomUUID()}/${sha}.zip`;
  const { error } = await db.storage.from('skills').upload(objectPath, zip, { contentType: 'application/zip' });
  if (error) throw error;
  return objectPath;
}

export type Roots = { agentsRoot: string; sharedRoot: string; sock: string };

export async function tmpRoots(): Promise<Roots> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agenthub-'));
  return {
    agentsRoot: path.join(base, 'agents'),
    sharedRoot: path.join(base, 'shared'),
    sock: path.join(base, 'missing.sock'),
  };
}

export function testConfig(projectId: string, roots: Roots): Config {
  return {
    PROJECT_ID: projectId,
    SUPABASE_URL: inject('supabaseUrl'),
    SUPABASE_SECRET_KEY: inject('supabaseServiceKey'),
    VERTEX_API_EXPRESS_MODE_KEY: 'test',
    AGENTS_ROOT: roots.agentsRoot,
    SHARED_ROOT: roots.sharedRoot,
    SPRITE_API_SOCK: roots.sock,
    MODEL_ID: 'mock',
    PORT: 0,
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}
```

- [ ] **Step 4: 寫 run-store 與 project-store 的測試**

建立 `packages/runtime/test/run-store.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { NotFoundError, RunConflictError } from '../src/errors';
import {
  assertThreadInProject, createRun, failRunningRuns, finishRun, insertMessage, loadHistory,
} from '../src/run-store';
import { seedProject, seedThread, seedUser, testDb } from './helpers';

const db = testDb();

async function setup() {
  const userId = await seedUser(db);
  const projectId = await seedProject(db, userId);
  const threadId = await seedThread(db, projectId);
  return { userId, projectId, threadId };
}

describe('run-store', () => {
  it('assertThreadInProject：對話不屬於此專案時丟 NotFoundError', async () => {
    const a = await setup();
    const b = await setup();
    await expect(assertThreadInProject(db, a.threadId, a.projectId)).resolves.toBeUndefined();
    await expect(assertThreadInProject(db, a.threadId, b.projectId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('createRun：同一串對話同時建立兩個 run，恰好一個成功', async () => {
    const { threadId } = await setup();
    const results = await Promise.allSettled([createRun(db, threadId), createRun(db, threadId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RunConflictError);
  });

  it('finishRun 之後同一串對話可以再建立 run', async () => {
    const { threadId } = await setup();
    const first = await createRun(db, threadId);
    await finishRun(db, first, { status: 'failed', error: '測試' });
    const { data } = await db.from('runs').select('status, error, finished_at').eq('id', first).single();
    expect(data).toMatchObject({ status: 'failed', error: '測試' });
    expect(data!.finished_at).not.toBeNull();
    await expect(createRun(db, threadId)).resolves.toBeTypeOf('string');
  });

  it('loadHistory：只取 user 與 final，依時間排序並轉成 ModelMessage', async () => {
    const { threadId } = await setup();
    const runId = await createRun(db, threadId);
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: '問題一' });
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'delegation', content: '內部派工' });
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'final', content: '回答一' });
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: '問題二' });
    expect(await loadHistory(db, threadId)).toEqual([
      { role: 'user', content: '問題一' },
      { role: 'assistant', content: '回答一' },
      { role: 'user', content: '問題二' },
    ]);
  });

  it('loadHistory：超過上限時保留最新的訊息', async () => {
    const { threadId } = await setup();
    const runId = await createRun(db, threadId);
    for (const n of [1, 2, 3]) {
      await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: `第${n}則` });
    }
    expect(await loadHistory(db, threadId, 2)).toEqual([
      { role: 'user', content: '第2則' },
      { role: 'user', content: '第3則' },
    ]);
  });

  it('failRunningRuns：只把本專案 running 的 run 改成 failed', async () => {
    const a = await setup();
    const b = await setup();
    const runA = await createRun(db, a.threadId);
    const runB = await createRun(db, b.threadId);
    expect(await failRunningRuns(db, a.projectId, 'runtime 重啟')).toBe(1);
    const { data } = await db.from('runs').select('id, status, error').in('id', [runA, runB]);
    expect(data!.find((r) => r.id === runA)).toMatchObject({ status: 'failed', error: 'runtime 重啟' });
    expect(data!.find((r) => r.id === runB)).toMatchObject({ status: 'running' });
  });
});
```

建立 `packages/runtime/test/project-store.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { groupSecrets, loadInstances, loadSecrets } from '../src/project-store';
import { seedProject, seedTemplate, seedUser, testDb } from './helpers';

const db = testDb();

describe('project-store', () => {
  it('loadInstances 帶出範本創作者；loadSecrets 讀回 Vault 金鑰', async () => {
    const creatorId = await seedUser(db);
    const renterId = await seedUser(db);
    const templateId = await seedTemplate(db, creatorId, {
      name: '財務顧問',
      skills: [{ name: 'dcf', description: '估值', path: 'dcf' }],
      mcp_servers: [{ name: 'finmind', transport: 'stdio', command: 'npx', args: ['finmind-mcp'], required_secrets: [{ key: 'TOKEN' }] }],
    });
    const projectId = await seedProject(db, renterId);
    const { data: instanceId, error } = await db.rpc('hire_agent', {
      p_project_id: projectId,
      p_template_id: templateId,
      p_secrets: { finmind: { TOKEN: 't-1' } },
    });
    expect(error).toBeNull();

    const instances = await loadInstances(db, projectId);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      id: instanceId,
      role: 'consultant',
      name: '財務顧問',
      template_id: templateId,
      creator_id: creatorId,
      skills: [{ name: 'dcf', description: '估值', path: 'dcf' }],
    });

    const secrets = await loadSecrets(db, projectId);
    expect(secrets).toEqual([{ instance_id: instanceId, mcp_name: 'finmind', key: 'TOKEN', value: 't-1' }]);
  });

  it('groupSecrets 只取指定 agent 的金鑰，依 MCP 名稱分組', () => {
    const rows = [
      { instance_id: 'a', mcp_name: 'm1', key: 'K1', value: 'v1' },
      { instance_id: 'a', mcp_name: 'm1', key: 'K2', value: 'v2' },
      { instance_id: 'a', mcp_name: 'm2', key: 'K3', value: 'v3' },
      { instance_id: 'b', mcp_name: 'm1', key: 'K1', value: 'other' },
    ];
    expect(groupSecrets(rows, 'a')).toEqual({ m1: { K1: 'v1', K2: 'v2' }, m2: { K3: 'v3' } });
  });
});
```

- [ ] **Step 5: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test
```

Expected: FAIL，`Failed to resolve import "../src/run-store"`。

- [ ] **Step 6: 實作 run-store 與 project-store**

建立 `packages/runtime/src/run-store.ts`：

```ts
import type { ModelMessage } from 'ai';
import type { Db } from './db';
import { NotFoundError, RunConflictError } from './errors';
import type { MessageKind } from './types';

export type RunResult = { status: 'succeeded' } | { status: 'failed'; error: string };

export type NewMessage = {
  thread_id: string;
  run_id: string;
  speaker_instance_id: string | null;
  kind: MessageKind;
  content: string;
  round?: number | null;
  ui_message?: unknown;
  tool_events?: unknown[];
};

export async function assertThreadInProject(db: Db, threadId: string, projectId: string): Promise<void> {
  const { data, error } = await db
    .from('threads')
    .select('id')
    .eq('id', threadId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError(`找不到對話 ${threadId}`);
}

export async function createRun(db: Db, threadId: string): Promise<string> {
  const { data, error } = await db.from('runs').insert({ thread_id: threadId }).select('id').single();
  if (error) {
    if (error.code === '23505') throw new RunConflictError('這串對話還在處理中');
    throw error;
  }
  return data.id;
}

export async function finishRun(db: Db, runId: string, result: RunResult): Promise<void> {
  const { error } = await db
    .from('runs')
    .update({
      status: result.status,
      error: result.status === 'failed' ? result.error : null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) throw error;
}

export async function insertMessage(db: Db, m: NewMessage): Promise<string> {
  const { data, error } = await db.from('messages').insert(m).select('id').single();
  if (error) throw error;
  return data.id;
}

export async function loadHistory(db: Db, threadId: string, limit = 50): Promise<ModelMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('kind, content')
    .eq('thread_id', threadId)
    .in('kind', ['user', 'final'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data
    .reverse()
    .map((m): ModelMessage => (m.kind === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content }));
}

export async function failRunningRuns(db: Db, projectId: string, reason: string): Promise<number> {
  const { data: threads, error: threadsError } = await db.from('threads').select('id').eq('project_id', projectId);
  if (threadsError) throw threadsError;
  if (threads.length === 0) return 0;
  const { data, error } = await db
    .from('runs')
    .update({ status: 'failed', error: reason, finished_at: new Date().toISOString() })
    .eq('status', 'running')
    .in('thread_id', threads.map((t) => t.id))
    .select('id');
  if (error) throw error;
  return data.length;
}
```

建立 `packages/runtime/src/project-store.ts`：

```ts
import type { Db } from './db';
import type { AgentInstance, SecretRow } from './types';

export async function loadInstances(db: Db, projectId: string): Promise<AgentInstance[]> {
  const { data, error } = await db
    .from('agent_instances')
    .select('id, project_id, template_id, role, name, system_prompt, skills_zip_path, skills, mcp_servers, template:agent_templates(creator_id)')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(({ template, ...row }) => ({
    ...row,
    creator_id: (template as { creator_id: string } | null)?.creator_id ?? null,
  })) as AgentInstance[];
}

export async function loadSecrets(db: Db, projectId: string): Promise<SecretRow[]> {
  const { data, error } = await db.rpc('get_project_secrets', { p_project_id: projectId });
  if (error) throw error;
  return data as SecretRow[];
}

export function groupSecrets(rows: SecretRow[], instanceId: string): Record<string, Record<string, string>> {
  const grouped: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    if (row.instance_id !== instanceId) continue;
    grouped[row.mcp_name] ??= {};
    grouped[row.mcp_name][row.key] = row.value;
  }
  return grouped;
}
```

- [ ] **Step 7: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test
pnpm -F @agenthub/runtime typecheck
```

Expected: 兩個測試檔全部 PASS；typecheck 沒有錯誤。

- [ ] **Step 8: Commit**

```bash
git add packages/runtime pnpm-lock.yaml
git commit -m "feat(runtime): 套件骨架與資料存取層"
```

---

### Task 4: skills 與專案檔案同步

**Files:**
- Create: `packages/runtime/src/sync.ts`
- Test: `packages/runtime/test/sync.test.ts`

**Interfaces:**
- Consumes: `Db`、`AgentInstance`、`SyncError`、測試工具 `uploadSkillsZip`、`tmpRoots`
- Produces:
  - `agentDir(agentsRoot: string, instanceId: string): string`
  - `skillsDir(agentsRoot: string, instanceId: string): string`
  - `syncSkills(db: Db, agentsRoot: string, instance: Pick<AgentInstance, 'id' | 'skills_zip_path'>): Promise<void>`
  - `syncSharedFiles(db: Db, projectId: string, sharedRoot: string): Promise<string[]>`：回傳目前的檔名清單

- [ ] **Step 1: 寫測試**

建立 `packages/runtime/test/sync.test.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { SyncError } from '../src/errors';
import { agentDir, skillsDir, syncSharedFiles, syncSkills } from '../src/sync';
import { testDb, tmpRoots, uploadSkillsZip } from './helpers';

const db = testDb();
const exists = (p: string) => stat(p).then(() => true, () => false);

describe('syncSkills', () => {
  it('下載並解壓 skills', async () => {
    const { agentsRoot } = await tmpRoots();
    const zipPath = await uploadSkillsZip(db, { 'contract/SKILL.md': '# 審合約', 'contract/check.sh': 'echo ok' });
    const id = randomUUID();
    await syncSkills(db, agentsRoot, { id, skills_zip_path: zipPath });
    expect(await readFile(path.join(skillsDir(agentsRoot, id), 'contract/SKILL.md'), 'utf8')).toBe('# 審合約');
    expect(await readFile(path.join(skillsDir(agentsRoot, id), 'contract/check.sh'), 'utf8')).toBe('echo ok');
  });

  it('版本相同時不重新下載', async () => {
    const { agentsRoot } = await tmpRoots();
    const zipPath = await uploadSkillsZip(db, { 'a/SKILL.md': 'A' });
    const id = randomUUID();
    await syncSkills(db, agentsRoot, { id, skills_zip_path: zipPath });
    const sentinel = path.join(skillsDir(agentsRoot, id), 'sentinel.txt');
    await writeFile(sentinel, 'keep');
    await syncSkills(db, agentsRoot, { id, skills_zip_path: zipPath });
    expect(await exists(sentinel)).toBe(true);
  });

  it('版本改變時清掉舊檔', async () => {
    const { agentsRoot } = await tmpRoots();
    const id = randomUUID();
    await syncSkills(db, agentsRoot, { id, skills_zip_path: await uploadSkillsZip(db, { 'old/SKILL.md': 'old' }) });
    await syncSkills(db, agentsRoot, { id, skills_zip_path: await uploadSkillsZip(db, { 'new/SKILL.md': 'new' }) });
    expect(await exists(path.join(skillsDir(agentsRoot, id), 'old/SKILL.md'))).toBe(false);
    expect(await readFile(path.join(skillsDir(agentsRoot, id), 'new/SKILL.md'), 'utf8')).toBe('new');
  });

  it('zip 內含 ../ 路徑時拒絕，不寫到工作目錄外', async () => {
    const { agentsRoot } = await tmpRoots();
    const zip = zipSync({ '../evil.txt': strToU8('x') });
    const objectPath = `${randomUUID()}/evil.zip`;
    await db.storage.from('skills').upload(objectPath, zip, { contentType: 'application/zip' });
    const id = randomUUID();
    await expect(syncSkills(db, agentsRoot, { id, skills_zip_path: objectPath })).rejects.toBeInstanceOf(SyncError);
    expect(await exists(path.join(agentDir(agentsRoot, id), 'evil.txt'))).toBe(false);
  });

  it('沒有 skill 時只建立工作目錄', async () => {
    const { agentsRoot } = await tmpRoots();
    const id = randomUUID();
    await syncSkills(db, agentsRoot, { id, skills_zip_path: null });
    expect(await exists(agentDir(agentsRoot, id))).toBe(true);
  });

  it('Storage 找不到 zip 時丟出 SyncError', async () => {
    const { agentsRoot } = await tmpRoots();
    await expect(
      syncSkills(db, agentsRoot, { id: randomUUID(), skills_zip_path: `${randomUUID()}/missing.zip` }),
    ).rejects.toBeInstanceOf(SyncError);
  });
});

describe('syncSharedFiles', () => {
  it('新增、更新、刪除都會反映到本機', async () => {
    const { sharedRoot } = await tmpRoots();
    const projectId = randomUUID();
    const bucket = db.storage.from('project-files');
    await bucket.upload(`${projectId}/a.txt`, 'A1', { contentType: 'text/plain' });
    await bucket.upload(`${projectId}/b.txt`, 'B1', { contentType: 'text/plain' });

    expect((await syncSharedFiles(db, projectId, sharedRoot)).sort()).toEqual(['a.txt', 'b.txt']);
    expect(await readFile(path.join(sharedRoot, 'a.txt'), 'utf8')).toBe('A1');

    await new Promise((r) => setTimeout(r, 1100));
    await bucket.upload(`${projectId}/a.txt`, 'A2', { contentType: 'text/plain', upsert: true });
    await bucket.remove([`${projectId}/b.txt`]);

    expect(await syncSharedFiles(db, projectId, sharedRoot)).toEqual(['a.txt']);
    expect(await readFile(path.join(sharedRoot, 'a.txt'), 'utf8')).toBe('A2');
    expect(await exists(path.join(sharedRoot, 'b.txt'))).toBe(false);
  });

  it('專案沒有檔案時回傳空陣列', async () => {
    const { sharedRoot } = await tmpRoots();
    expect(await syncSharedFiles(db, randomUUID(), sharedRoot)).toEqual([]);
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/sync.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/sync"`。

- [ ] **Step 3: 實作**

建立 `packages/runtime/src/sync.ts`：

```ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { Db } from './db';
import { SyncError } from './errors';
import type { AgentInstance } from './types';

const SKILLS_MARKER = '.zip-path';
const SHARED_STATE = '.sync.json';

export function agentDir(agentsRoot: string, instanceId: string): string {
  return path.join(agentsRoot, instanceId);
}

export function skillsDir(agentsRoot: string, instanceId: string): string {
  return path.join(agentsRoot, instanceId, 'skills');
}

export async function syncSkills(
  db: Db,
  agentsRoot: string,
  instance: Pick<AgentInstance, 'id' | 'skills_zip_path'>,
): Promise<void> {
  await mkdir(agentDir(agentsRoot, instance.id), { recursive: true });
  if (!instance.skills_zip_path) return;

  const dir = skillsDir(agentsRoot, instance.id);
  const current = await readFile(path.join(dir, SKILLS_MARKER), 'utf8').catch(() => null);
  if (current === instance.skills_zip_path) return;

  const { data, error } = await db.storage.from('skills').download(instance.skills_zip_path);
  if (error || !data) throw new SyncError(`無法下載 skill 檔案 ${instance.skills_zip_path}：${error?.message ?? '空檔案'}`);
  const files = unzipSync(new Uint8Array(await data.arrayBuffer()));

  const entries = Object.entries(files).filter(([name]) => !name.endsWith('/'));
  for (const [name] of entries) {
    const target = path.resolve(dir, name);
    if (!target.startsWith(dir + path.sep)) throw new SyncError(`skill zip 內含不合法的路徑：${name}`);
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, content] of entries) {
    const target = path.resolve(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(path.join(dir, SKILLS_MARKER), instance.skills_zip_path);
}

export async function syncSharedFiles(db: Db, projectId: string, sharedRoot: string): Promise<string[]> {
  await mkdir(sharedRoot, { recursive: true });
  const bucket = db.storage.from('project-files');
  const { data, error } = await bucket.list(projectId, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw new SyncError(`無法列出專案檔案：${error.message}`);
  const objects = data.filter((o) => o.id !== null);

  const statePath = path.join(sharedRoot, SHARED_STATE);
  const previous: Record<string, string> = JSON.parse(await readFile(statePath, 'utf8').catch(() => '{}'));
  const next: Record<string, string> = {};

  for (const o of objects) {
    const stamp = o.updated_at ?? '';
    if (previous[o.name] !== stamp) {
      const { data: blob, error: downloadError } = await bucket.download(`${projectId}/${o.name}`);
      if (downloadError || !blob) throw new SyncError(`無法下載專案檔案 ${o.name}：${downloadError?.message ?? '空檔案'}`);
      await writeFile(path.join(sharedRoot, o.name), Buffer.from(await blob.arrayBuffer()));
    }
    next[o.name] = stamp;
  }
  for (const name of Object.keys(previous)) {
    if (!(name in next)) await rm(path.join(sharedRoot, name), { force: true });
  }
  await writeFile(statePath, JSON.stringify(next));
  return objects.map((o) => o.name);
}
```

- [ ] **Step 4: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/sync.test.ts
```

Expected: 8 個測試全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): skills 與專案檔案同步"
```

---

### Task 5: bash 與檔案工具

**Files:**
- Create: `packages/runtime/src/tools/bash.ts`、`packages/runtime/src/tools/files.ts`
- Test: `packages/runtime/test/tools.test.ts`

**Interfaces:**
- Consumes: 無（純本機）
- Produces:
  - `BASH_TIMEOUT_MS = 120_000`、`MAX_OUTPUT = 20_000`
  - `truncate(text: string, max?: number): string`
  - `runBash(command: string, cwd: string, timeoutMs?: number, abortSignal?: AbortSignal): Promise<{ exitCode: number | null; output: string; timedOut: boolean }>`
  - `bashTool(cwd: string)`、`readFileTool(cwd: string)`、`writeFileTool(cwd: string)`：AI SDK `tool()`

- [ ] **Step 1: 寫測試**

建立 `packages/runtime/test/tools.test.ts`：

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT, runBash, truncate } from '../src/tools/bash';
import { readFileTool, writeFileTool } from '../src/tools/files';
import { tmpRoots } from './helpers';

// 工具執行選項：測試只用得到這兩個欄位
const opts = { toolCallId: 't', messages: [] } as never;

async function workDir() {
  const { agentsRoot } = await tmpRoots();
  const dir = path.join(agentsRoot, 'a1');
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('runBash', () => {
  it('在指定目錄執行', async () => {
    const cwd = await workDir();
    await runBash('echo hi > out.txt', cwd);
    expect(await readFile(path.join(cwd, 'out.txt'), 'utf8')).toBe('hi\n');
  });

  it('非 0 結束碼回傳而不丟例外，並包含 stderr', async () => {
    const r = await runBash('echo boom >&2; exit 3', await workDir());
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('boom');
  });

  it('逾時會中止', async () => {
    const r = await runBash('sleep 5', await workDir(), 200);
    expect(r.timedOut).toBe(true);
  });

  it('輸出過長會截斷', async () => {
    const r = await runBash(`head -c 50000 /dev/zero | tr '\\0' a`, await workDir());
    expect(r.output.length).toBeLessThan(MAX_OUTPUT + 100);
    expect(r.output).toContain('已截斷');
  });
});

describe('truncate', () => {
  it('短文字不變', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });
});

describe('read_file / write_file', () => {
  it('寫入時自動建立資料夾，讀取支援相對與絕對路徑', async () => {
    const cwd = await workDir();
    const w = await writeFileTool(cwd).execute!({ path: 'notes/a.md', content: '內容' }, opts);
    expect(w).toMatchObject({ ok: true });
    expect(await readFileTool(cwd).execute!({ path: 'notes/a.md' }, opts)).toEqual({ content: '內容' });
    expect(await readFileTool(cwd).execute!({ path: path.join(cwd, 'notes/a.md') }, opts)).toEqual({ content: '內容' });
  });

  it('檔案不存在時回傳錯誤而不丟例外', async () => {
    const r = await readFileTool(await workDir()).execute!({ path: 'nope.txt' }, opts);
    expect(r).toHaveProperty('error');
  });

  it('讀取過長的檔案會截斷', async () => {
    const cwd = await workDir();
    await writeFile(path.join(cwd, 'big.txt'), 'x'.repeat(50_000));
    const r = (await readFileTool(cwd).execute!({ path: 'big.txt' }, opts)) as unknown as { content: string };
    expect(r.content).toContain('已截斷');
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/tools.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/tools/bash"`。

- [ ] **Step 3: 實作**

建立 `packages/runtime/src/tools/bash.ts`：

```ts
import { spawn } from 'node:child_process';
import { tool } from 'ai';
import { z } from 'zod';

export const BASH_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT = 20_000;

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[已截斷，原長度 ${text.length} 字元]`;
}

export function runBash(
  command: string,
  cwd: string,
  timeoutMs = BASH_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, env: process.env, signal: abortSignal });
    let output = '';
    let total = 0;
    const append = (chunk: Buffer) => {
      total += chunk.length;
      if (output.length < MAX_OUTPUT * 2) output += chunk.toString();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const done = (exitCode: number | null, extra = '') => {
      clearTimeout(timer);
      const text = total > output.length ? output + '…'.repeat(MAX_OUTPUT) : output;
      resolve({ exitCode, output: truncate(text + extra), timedOut });
    };
    child.on('close', (code) => done(code));
    child.on('error', (err) => done(null, `\n${err.message}`));
  });
}

export function bashTool(cwd: string) {
  return tool({
    description: '在你的工作目錄執行 bash 指令。單次最長 120 秒，輸出超過 20000 字元會被截斷。',
    inputSchema: z.object({ command: z.string().describe('要執行的 bash 指令') }),
    execute: async ({ command }, { abortSignal }) => runBash(command, cwd, BASH_TIMEOUT_MS, abortSignal),
  });
}
```

建立 `packages/runtime/src/tools/files.ts`：

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { errorText } from '../errors';
import { truncate } from './bash';

export function readFileTool(cwd: string) {
  return tool({
    description: '讀取檔案。相對路徑以你的工作目錄為基準，也可以用絕對路徑讀專案共用檔案。超過 20000 字元會被截斷。',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path: p }) => {
      try {
        return { content: truncate(await readFile(path.resolve(cwd, p), 'utf8')) };
      } catch (e) {
        return { error: errorText(e) };
      }
    },
  });
}

export function writeFileTool(cwd: string) {
  return tool({
    description: '寫入檔案（覆蓋），需要的資料夾會自動建立。相對路徑以你的工作目錄為基準。',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path: p, content }) => {
      try {
        const target = path.resolve(cwd, p);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
        return { ok: true, path: target };
      } catch (e) {
        return { error: errorText(e) };
      }
    },
  });
}
```

- [ ] **Step 4: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/tools.test.ts
```

Expected: 8 個測試全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): bash 與檔案工具"
```

---

### Task 6: 記憶工具

**Files:**
- Create: `packages/runtime/src/tools/memory.ts`
- Test: `packages/runtime/test/memory.test.ts`

**Interfaces:**
- Consumes: `Db`、測試工具 `seedUser`、`seedProject`、`seedConsultant`
- Produces:
  - `MEMORY_PROMPT_LIMIT = 50`
  - `type MemoryRow = { id: string; instance_id: string | null; content: string; created_at: string }`
  - `loadMemories(db, projectId, instanceId): Promise<MemoryRow[]>`：最新的在前
  - `formatMemoryBlock(rows: MemoryRow[]): string`
  - `memoryTools(db, projectId, instanceId): { remember, recall }`

- [ ] **Step 1: 寫測試**

建立 `packages/runtime/test/memory.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { formatMemoryBlock, loadMemories, memoryTools } from '../src/tools/memory';
import { seedConsultant, seedProject, seedUser, testDb } from './helpers';

const db = testDb();
// 工具執行選項：測試只用得到這兩個欄位
const opts = { toolCallId: 't', messages: [] } as never;

async function setup() {
  const projectId = await seedProject(db, await seedUser(db));
  const a = await seedConsultant(db, projectId, { name: 'A' });
  const b = await seedConsultant(db, projectId, { name: 'B' });
  return { projectId, a, b };
}

describe('記憶', () => {
  it('remember 依 scope 寫入；loadMemories 看得到自己的私有與專案共用，看不到別人的私有', async () => {
    const { projectId, a, b } = await setup();
    await memoryTools(db, projectId, a).remember.execute!({ content: 'A 的私事', scope: 'private' }, opts);
    await memoryTools(db, projectId, a).remember.execute!({ content: '客戶偏好保守', scope: 'project' }, opts);
    await memoryTools(db, projectId, b).remember.execute!({ content: 'B 的私事', scope: 'private' }, opts);

    const seenByA = (await loadMemories(db, projectId, a)).map((m) => m.content).sort();
    expect(seenByA).toEqual(['A 的私事', '客戶偏好保守']);
    const seenByB = (await loadMemories(db, projectId, b)).map((m) => m.content).sort();
    expect(seenByB).toEqual(['B 的私事', '客戶偏好保守']);
  });

  it('recall 用關鍵字搜尋，% 與 _ 當一般字元', async () => {
    const { projectId, a } = await setup();
    const tools = memoryTools(db, projectId, a);
    await tools.remember.execute!({ content: '毛利率目標 40%', scope: 'project' }, opts);
    await tools.remember.execute!({ content: '毛利率目標四成', scope: 'project' }, opts);

    const r = (await tools.recall.execute!({ query: '40%' }, opts)) as unknown as { results: { content: string }[] };
    expect(r.results.map((m) => m.content)).toEqual(['毛利率目標 40%']);
  });

  it('formatMemoryBlock 標示私有與專案', () => {
    expect(formatMemoryBlock([])).toBe('（目前沒有記憶）');
    expect(
      formatMemoryBlock([
        { id: '1', instance_id: 'x', content: '私', created_at: '' },
        { id: '2', instance_id: null, content: '公', created_at: '' },
      ]),
    ).toBe('- [私有] 私\n- [專案] 公');
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/memory.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/tools/memory"`。

- [ ] **Step 3: 實作**

建立 `packages/runtime/src/tools/memory.ts`：

```ts
import { tool } from 'ai';
import { z } from 'zod';
import type { Db } from '../db';

export const MEMORY_PROMPT_LIMIT = 50;

export type MemoryRow = { id: string; instance_id: string | null; content: string; created_at: string };

const visibleTo = (instanceId: string) => `instance_id.is.null,instance_id.eq.${instanceId}`;

export async function loadMemories(db: Db, projectId: string, instanceId: string): Promise<MemoryRow[]> {
  const { data, error } = await db
    .from('memories')
    .select('id, instance_id, content, created_at')
    .eq('project_id', projectId)
    .or(visibleTo(instanceId))
    .order('created_at', { ascending: false })
    .limit(MEMORY_PROMPT_LIMIT);
  if (error) throw error;
  return data;
}

export function formatMemoryBlock(rows: MemoryRow[]): string {
  if (rows.length === 0) return '（目前沒有記憶）';
  return rows.map((r) => `- [${r.instance_id ? '私有' : '專案'}] ${r.content}`).join('\n');
}

export function memoryTools(db: Db, projectId: string, instanceId: string) {
  return {
    remember: tool({
      description:
        '寫入一筆記憶。只記使用者明確說過的事實與偏好，不要記你自己或其他 agent 推論出的內容。scope=private 只有你看得到；scope=project 專案裡所有 agent 都看得到。',
      inputSchema: z.object({
        content: z.string().min(1),
        scope: z.enum(['private', 'project']),
      }),
      execute: async ({ content, scope }) => {
        const { error } = await db.from('memories').insert({
          project_id: projectId,
          instance_id: scope === 'private' ? instanceId : null,
          content,
          created_by_instance_id: instanceId,
        });
        return error ? { error: error.message } : { ok: true };
      },
    }),
    recall: tool({
      description: '用關鍵字搜尋你的私有記憶和專案共用記憶。',
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => {
        const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const { data, error } = await db
          .from('memories')
          .select('instance_id, content, created_at')
          .eq('project_id', projectId)
          .or(visibleTo(instanceId))
          .ilike('content', pattern)
          .order('created_at', { ascending: false })
          .limit(20);
        if (error) return { error: error.message };
        return {
          results: data.map((m) => ({ scope: m.instance_id ? 'private' : 'project', content: m.content, created_at: m.created_at })),
        };
      },
    }),
  };
}
```

- [ ] **Step 4: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/memory.test.ts
```

Expected: 3 個測試全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): 記憶工具"
```

---

### Task 7: MCP 連線

**Files:**
- Create: `packages/runtime/src/mcp.ts`
- Create: `packages/runtime/test/fixtures/echo-mcp.mjs`
- Test: `packages/runtime/test/mcp.test.ts`

**Interfaces:**
- Consumes: `McpServerConfig`、`errorText`
- Produces:
  - `MCP_CONNECT_TIMEOUT_MS = 60_000`
  - `substituteSecrets(template: string, secrets: Record<string, string>): string`
  - `sanitizeToolName(name: string): string`
  - `type McpHandle = { tools: ToolSet; warnings: string[]; close: () => Promise<void> }`
  - `connectMcpServers(servers: McpServerConfig[], secretsByServer: Record<string, Record<string, string>>, cwd: string, connect?: typeof createMCPClient): Promise<McpHandle>`：任何一個 MCP 失敗都不丟例外，改寫進 `warnings`（文字含「目前無法使用」）

- [ ] **Step 1: 建立測試用的最小 stdio MCP server**

建立 `packages/runtime/test/fixtures/echo-mcp.mjs`：

```js
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [{
          name: 'echo',
          description: 'Echo text with ECHO_PREFIX',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        }],
      },
    });
  } else if (msg.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: `${process.env.ECHO_PREFIX ?? ''}${msg.params.arguments.text}` }] },
    });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
```

- [ ] **Step 2: 寫測試**

建立 `packages/runtime/test/mcp.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import type { createMCPClient } from '@ai-sdk/mcp';
import { describe, expect, it } from 'vitest';
import { connectMcpServers, sanitizeToolName, substituteSecrets } from '../src/mcp';
import { tmpRoots } from './helpers';

const fixture = fileURLToPath(new URL('./fixtures/echo-mcp.mjs', import.meta.url));
// 工具執行選項：測試只用得到這兩個欄位
const opts = { toolCallId: 't', messages: [] } as never;

describe('substituteSecrets / sanitizeToolName', () => {
  it('把 ${KEY} 換成金鑰，找不到的保留原樣', () => {
    expect(substituteSecrets('Bearer ${TOKEN} ${OTHER}', { TOKEN: 'abc' })).toBe('Bearer abc ${OTHER}');
  });

  it('工具名稱只留英數與底線，最長 64 字元', () => {
    expect(sanitizeToolName('台股-data__get price')).toBe('___data__get_price');
    expect(sanitizeToolName('x'.repeat(80))).toHaveLength(64);
  });
});

describe('connectMcpServers', () => {
  it('stdio：啟動 MCP、金鑰放進環境變數、工具加上 server 前綴', async () => {
    const { agentsRoot } = await tmpRoots();
    const handle = await connectMcpServers(
      [{ name: 'echo-server', transport: 'stdio', command: process.execPath, args: [fixture] }],
      { 'echo-server': { ECHO_PREFIX: 'P:' } },
      agentsRoot,
    );
    try {
      expect(handle.warnings).toEqual([]);
      expect(Object.keys(handle.tools)).toEqual(['echo_server__echo']);
      const result = await handle.tools.echo_server__echo.execute!({ text: 'hi' }, opts);
      expect(JSON.stringify(result)).toContain('P:hi');
    } finally {
      await handle.close();
    }
  });

  it('http：headers 裡的 ${KEY} 會換成金鑰', async () => {
    const seen: unknown[] = [];
    const fakeConnect = (async (config: { transport: unknown }) => {
      seen.push(config.transport);
      return { tools: async () => ({}), close: async () => {} };
    }) as unknown as typeof createMCPClient;
    await connectMcpServers(
      [{ name: 'remote', transport: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer ${API_KEY}' } }],
      { remote: { API_KEY: 'secret-1' } },
      '/tmp',
      fakeConnect,
    );
    expect(seen[0]).toEqual({ type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer secret-1' } });
  });

  it('啟動失敗不丟例外，改寫進 warnings，其他 MCP 照常可用', async () => {
    const { agentsRoot } = await tmpRoots();
    const handle = await connectMcpServers(
      [
        { name: 'broken', transport: 'stdio', command: '/nonexistent/command' },
        { name: 'echo', transport: 'stdio', command: process.execPath, args: [fixture] },
      ],
      {},
      agentsRoot,
    );
    try {
      expect(handle.warnings).toHaveLength(1);
      expect(handle.warnings[0]).toContain('broken');
      expect(handle.warnings[0]).toContain('目前無法使用');
      expect(Object.keys(handle.tools)).toEqual(['echo__echo']);
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 3: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/mcp.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/mcp"`。

- [ ] **Step 4: 實作**

建立 `packages/runtime/src/mcp.ts`：

```ts
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';
import { errorText } from './errors';
import type { McpServerConfig } from './types';

export const MCP_CONNECT_TIMEOUT_MS = 60_000;

export type McpHandle = { tools: ToolSet; warnings: string[]; close: () => Promise<void> };

type McpClient = Awaited<ReturnType<typeof createMCPClient>>;

export function substituteSecrets(template: string, secrets: Record<string, string>): string {
  return template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key: string) => secrets[key] ?? match);
}

export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超過 ${ms / 1000} 秒沒有回應`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function transportFor(server: McpServerConfig, secrets: Record<string, string>, cwd: string) {
  if (server.transport === 'http') {
    if (!server.url) throw new Error('缺少 url');
    const headers = Object.fromEntries(
      Object.entries(server.headers ?? {}).map(([k, v]) => [k, substituteSecrets(v, secrets)]),
    );
    return { type: 'http' as const, url: server.url, headers };
  }
  if (!server.command) throw new Error('缺少 command');
  return new Experimental_StdioMCPTransport({ command: server.command, args: server.args ?? [], env: secrets, cwd });
}

export async function connectMcpServers(
  servers: McpServerConfig[],
  secretsByServer: Record<string, Record<string, string>>,
  cwd: string,
  connect: typeof createMCPClient = createMCPClient,
): Promise<McpHandle> {
  const clients: McpClient[] = [];
  const warnings: string[] = [];
  const tools: ToolSet = {};

  for (const server of servers) {
    try {
      const transport = transportFor(server, secretsByServer[server.name] ?? {}, cwd);
      const client = await withTimeout(connect({ transport }), MCP_CONNECT_TIMEOUT_MS, `MCP「${server.name}」`);
      clients.push(client);
      const serverTools = await withTimeout(client.tools(), MCP_CONNECT_TIMEOUT_MS, `MCP「${server.name}」`);
      for (const [name, definition] of Object.entries(serverTools)) {
        tools[sanitizeToolName(`${server.name}__${name}`)] = definition as ToolSet[string];
      }
    } catch (e) {
      warnings.push(`MCP「${server.name}」目前無法使用：${errorText(e)}`);
    }
  }

  return {
    tools,
    warnings,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
```

- [ ] **Step 5: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/mcp.test.ts
```

Expected: 5 個測試全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): MCP 連線"
```

---

### Task 8: 用量記錄、顧問 prompt 與組裝

**Files:**
- Create: `packages/runtime/src/usage.ts`、`packages/runtime/src/agents/prompts.ts`、`packages/runtime/src/agents/build.ts`
- Create: `packages/runtime/test/mock-model.ts`
- Test: `packages/runtime/test/build.test.ts`

**Interfaces:**
- Consumes: `agentDir`、`skillsDir`（Task 4）；`bashTool`、`readFileTool`、`writeFileTool`（Task 5）；`loadMemories`、`formatMemoryBlock`、`memoryTools`、`MemoryRow`（Task 6）；`connectMcpServers`（Task 7）；`errorText`、`Config`、`Db`、`AgentInstance`
- Produces:
  - `type StepLike = { usage: LanguageModelUsage; model: { modelId: string } }`
  - `usageRow(ctx: UsageContext, step: StepLike)`、`usageRecorder(ctx: UsageContext): (step: StepLike) => Promise<void>`；`UsageContext = { db: Db; projectId: string; runId: string; instance: AgentInstance }`
  - `buildConsultantInstructions(p: ConsultantPromptInput): string`
  - `MAX_STEPS = 30`
  - `buildConsultant(ctx: ConsultantContext): Promise<BuiltAgent>`；`BuiltAgent = { instructions: string; warnings: string[]; streamUI(input: { messages: ModelMessage[]; abortSignal?: AbortSignal }): Promise<ReadableStream<UIMessageChunk>>; close(): Promise<void> }`
  - 測試工具 `usage`、`textTurn`、`toolTurn`、`mockModel`、`failingModel`、`promptText`

- [ ] **Step 1: 建立 mock 模型工具**

建立 `packages/runtime/test/mock-model.ts`：

```ts
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

export const usage = {
  inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: 0 },
  outputTokens: { total: 5, text: 4, reasoning: 1 },
};

type Turn = { stream: ReadableStream<any> };

export function textTurn(text: string, chunkDelayInMs?: number): Turn {
  const pieces = chunkDelayInMs ? Array.from(text) : [text];
  return {
    stream: simulateReadableStream({
      chunkDelayInMs,
      chunks: [
        { type: 'text-start', id: 't1' },
        ...pieces.map((delta) => ({ type: 'text-delta', id: 't1', delta })),
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ],
    }),
  };
}

export function toolTurn(toolName: string, input: unknown, toolCallId = 'call-1'): Turn {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
      ],
    }),
  };
}

export function mockModel(...turns: Turn[]) {
  return new MockLanguageModelV4({ doStream: turns });
}

export function failingModel(message: string) {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new Error(message);
    },
  });
}

export function promptText(model: MockLanguageModelV4, call = 0): string {
  return JSON.stringify(model.doStreamCalls[call].prompt);
}
```

- [ ] **Step 2: 寫測試**

建立 `packages/runtime/test/build.test.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readUIMessageStream } from 'ai';
import { describe, expect, it } from 'vitest';
import { buildConsultant } from '../src/agents/build';
import { buildConsultantInstructions } from '../src/agents/prompts';
import { usageRow } from '../src/usage';
import type { AgentInstance } from '../src/types';
import { seedConsultant, seedProject, seedUser, testDb, tmpRoots } from './helpers';
import { mockModel, promptText, textTurn } from './mock-model';

const db = testDb();
const fixture = fileURLToPath(new URL('./fixtures/echo-mcp.mjs', import.meta.url));

function instance(fields: Partial<AgentInstance> = {}): AgentInstance {
  return {
    id: randomUUID(), project_id: randomUUID(), template_id: randomUUID(), creator_id: randomUUID(),
    role: 'consultant', name: '法務顧問', system_prompt: '你是法務顧問。',
    skills_zip_path: null, skills: [], mcp_servers: [], ...fields,
  };
}

describe('buildConsultantInstructions', () => {
  it('包含創作者 prompt、工作目錄、專案檔案、skill 路徑、記憶與 MCP 警告', () => {
    const text = buildConsultantInstructions({
      instance: instance({ skills: [{ name: '審合約', description: '檢查合約風險', path: 'contract' }] }),
      workDir: '/agents/x',
      skillsDir: '/agents/x/skills',
      sharedRoot: '/shared',
      sharedFiles: ['財報.pdf'],
      memories: [{ id: '1', instance_id: null, content: '客戶偏好保守', created_at: '' }],
      mcpWarnings: ['MCP「finmind」目前無法使用：timeout'],
    });
    expect(text).toContain('你是法務顧問。');
    expect(text).toContain('/agents/x');
    expect(text).toContain('/shared/財報.pdf');
    expect(text).toContain('審合約：檢查合約風險（完整說明：/agents/x/skills/contract/SKILL.md）');
    expect(text).toContain('- [專案] 客戶偏好保守');
    expect(text).toContain('MCP「finmind」目前無法使用');
  });

  it('沒有檔案、skill、記憶時顯示空狀態', () => {
    const text = buildConsultantInstructions({
      instance: instance(), workDir: '/w', skillsDir: '/w/skills', sharedRoot: '/shared',
      sharedFiles: [], memories: [], mcpWarnings: [],
    });
    expect(text).toContain('（目前沒有專案檔案）');
    expect(text).toContain('（沒有 skill）');
    expect(text).toContain('（目前沒有記憶）');
    expect(text).not.toContain('目前無法使用的工具');
  });
});

describe('usageRow', () => {
  it('把 AI SDK 的 usage 轉成 usage_events 欄位', () => {
    const inst = instance();
    const row = usageRow(
      { db, projectId: 'p', runId: 'r', instance: inst },
      {
        model: { modelId: 'gemini-3.8-flash' },
        usage: {
          inputTokens: 100, outputTokens: 20, totalTokens: 120,
          inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 30, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 15, reasoningTokens: 5 },
        },
      },
    );
    expect(row).toEqual({
      run_id: 'r', project_id: 'p', instance_id: inst.id, template_id: inst.template_id, creator_id: inst.creator_id,
      model: 'gemini-3.8-flash', prompt_tokens: 100, output_tokens: 20, cached_tokens: 30, thought_tokens: 5,
    });
  });
});

describe('buildConsultant', () => {
  it('組出可串流的 agent，帶齊內建工具與 MCP 工具', async () => {
    const projectId = await seedProject(db, await seedUser(db));
    const id = await seedConsultant(db, projectId);
    const roots = await tmpRoots();
    const model = mockModel(textTurn('收到'));
    const built = await buildConsultant({
      db, model,
      config: { PROJECT_ID: projectId, AGENTS_ROOT: roots.agentsRoot, SHARED_ROOT: roots.sharedRoot },
      instance: instance({ id, project_id: projectId, mcp_servers: [{ name: 'echo', transport: 'stdio', command: process.execPath, args: [fixture] }] }),
      sharedFiles: [],
      secrets: {},
    });
    try {
      let last;
      for await (const m of readUIMessageStream({ stream: await built.streamUI({ messages: [{ role: 'user', content: '你好' }] }) })) {
        last = m;
      }
      expect(last?.parts.some((p) => p.type === 'text' && p.text === '收到')).toBe(true);
      const toolNames = model.doStreamCalls[0].tools?.map((t) => t.name).sort();
      expect(toolNames).toEqual(['bash', 'echo__echo', 'read_file', 'recall', 'remember', 'write_file']);
      expect(promptText(model)).toContain('你是法務顧問。');
    } finally {
      await built.close();
    }
  });
});
```

- [ ] **Step 3: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/build.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/agents/build"`。

- [ ] **Step 4: 實作用量記錄**

建立 `packages/runtime/src/usage.ts`：

```ts
import type { LanguageModelUsage } from 'ai';
import type { Db } from './db';
import type { AgentInstance } from './types';

export type StepLike = { usage: LanguageModelUsage; model: { modelId: string } };

export type UsageContext = { db: Db; projectId: string; runId: string; instance: AgentInstance };

export function usageRow(ctx: UsageContext, step: StepLike) {
  return {
    run_id: ctx.runId,
    project_id: ctx.projectId,
    instance_id: ctx.instance.id,
    template_id: ctx.instance.template_id,
    creator_id: ctx.instance.creator_id,
    model: step.model.modelId,
    prompt_tokens: step.usage.inputTokens ?? 0,
    output_tokens: step.usage.outputTokens ?? 0,
    cached_tokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
    thought_tokens: step.usage.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

export function usageRecorder(ctx: UsageContext): (step: StepLike) => Promise<void> {
  return async (step) => {
    const { error } = await ctx.db.from('usage_events').insert(usageRow(ctx, step));
    if (error) console.error('[usage] 寫入失敗', error.message);
  };
}
```

- [ ] **Step 5: 實作顧問 prompt**

建立 `packages/runtime/src/agents/prompts.ts`：

```ts
import path from 'node:path';
import { formatMemoryBlock, type MemoryRow } from '../tools/memory';
import type { AgentInstance } from '../types';

export type ConsultantPromptInput = {
  instance: AgentInstance;
  workDir: string;
  skillsDir: string;
  sharedRoot: string;
  sharedFiles: string[];
  memories: MemoryRow[];
  mcpWarnings: string[];
};

export function buildConsultantInstructions(p: ConsultantPromptInput): string {
  const files = p.sharedFiles.length
    ? p.sharedFiles.map((f) => `- ${path.join(p.sharedRoot, f)}`).join('\n')
    : '（目前沒有專案檔案）';
  const skills = p.instance.skills.length
    ? [
        ...p.instance.skills.map(
          (s) => `- ${s.name}：${s.description}（完整說明：${path.join(p.skillsDir, s.path, 'SKILL.md')}）`,
        ),
        '使用某個 skill 之前，先用 read_file 讀它的 SKILL.md，再照著做。',
      ].join('\n')
    : '（沒有 skill）';

  const sections = [
    p.instance.system_prompt.trim(),
    [
      '## 工作環境',
      `- 你的工作目錄：${p.workDir}。bash 指令和相對路徑都以這裡為基準。`,
      `- 專案共用檔案放在 ${p.sharedRoot}，所有 agent 都能讀寫。`,
    ].join('\n'),
    ['## 專案檔案', files].join('\n'),
    ['## 你的 skills', skills].join('\n'),
    [
      '## 記憶',
      formatMemoryBlock(p.memories),
      '只有使用者明確說過的事實與偏好，才用 remember 記下來。你自己或其他 agent 推論出的內容不要記。',
    ].join('\n'),
  ];
  if (p.mcpWarnings.length) {
    sections.push(['## 目前無法使用的工具', ...p.mcpWarnings.map((w) => `- ${w}`)].join('\n'));
  }
  return sections.join('\n\n');
}
```

- [ ] **Step 6: 實作顧問組裝**

建立 `packages/runtime/src/agents/build.ts`：

```ts
import { mkdir } from 'node:fs/promises';
import {
  generateId, stepCountIs, ToolLoopAgent,
  type LanguageModel, type ModelMessage, type ToolSet, type UIMessageChunk,
} from 'ai';
import type { Config } from '../config';
import type { Db } from '../db';
import { errorText } from '../errors';
import { connectMcpServers } from '../mcp';
import { agentDir, skillsDir } from '../sync';
import { bashTool } from '../tools/bash';
import { readFileTool, writeFileTool } from '../tools/files';
import { loadMemories, memoryTools } from '../tools/memory';
import type { AgentInstance } from '../types';
import type { StepLike } from '../usage';
import { buildConsultantInstructions } from './prompts';

export const MAX_STEPS = 30;

export type ConsultantContext = {
  db: Db;
  model: LanguageModel;
  config: Pick<Config, 'PROJECT_ID' | 'AGENTS_ROOT' | 'SHARED_ROOT'>;
  instance: AgentInstance;
  sharedFiles: string[];
  secrets: Record<string, Record<string, string>>;
  onStepEnd?: (step: StepLike) => Promise<void> | void;
};

export type BuiltAgent = {
  instructions: string;
  warnings: string[];
  streamUI(input: { messages: ModelMessage[]; abortSignal?: AbortSignal }): Promise<ReadableStream<UIMessageChunk>>;
  close(): Promise<void>;
};

export async function buildConsultant(ctx: ConsultantContext): Promise<BuiltAgent> {
  const workDir = agentDir(ctx.config.AGENTS_ROOT, ctx.instance.id);
  await mkdir(workDir, { recursive: true });

  const mcp = await connectMcpServers(ctx.instance.mcp_servers, ctx.secrets, workDir);
  const memories = await loadMemories(ctx.db, ctx.config.PROJECT_ID, ctx.instance.id);
  const instructions = buildConsultantInstructions({
    instance: ctx.instance,
    workDir,
    skillsDir: skillsDir(ctx.config.AGENTS_ROOT, ctx.instance.id),
    sharedRoot: ctx.config.SHARED_ROOT,
    sharedFiles: ctx.sharedFiles,
    memories,
    mcpWarnings: mcp.warnings,
  });

  const tools: ToolSet = {
    bash: bashTool(workDir),
    read_file: readFileTool(workDir),
    write_file: writeFileTool(workDir),
    ...memoryTools(ctx.db, ctx.config.PROJECT_ID, ctx.instance.id),
    ...mcp.tools,
  };

  const agent = new ToolLoopAgent({
    model: ctx.model,
    instructions,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    maxRetries: 3,
    onStepEnd: ctx.onStepEnd,
  });

  return {
    instructions,
    warnings: mcp.warnings,
    close: mcp.close,
    streamUI: async ({ messages, abortSignal }) => {
      const result = await agent.stream({ messages, abortSignal });
      return result.toUIMessageStream({ generateMessageId: generateId, onError: errorText });
    },
  };
}
```

- [ ] **Step 7: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/build.test.ts
pnpm -F @agenthub/runtime typecheck
```

Expected: 4 個測試全部 PASS；typecheck 沒有錯誤。如果 typecheck 回報 `onStepEnd` 型別不相容，把 `StepLike` 改成 `import type { StepResult, ToolSet } from 'ai'` 的 `StepResult<ToolSet>` 的子集合（只取 `usage`、`model`），不要改用 `any`。

- [ ] **Step 8: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): 用量記錄、顧問 prompt 與組裝"
```

---

### Task 9: Sprite「工作中」登記（keepalive）

**Files:**
- Create: `packages/runtime/src/keepalive.ts`
- Test: `packages/runtime/test/keepalive.test.ts`

**Interfaces:**
- Consumes: 無
- Produces:
  - `KEEPALIVE_INTERVAL_MS = 120_000`
  - `startKeepAlive(socketPath: string, taskName: string, intervalMs?: number): Promise<{ stop(): Promise<void> }>`：socket 不存在時只印警告，不丟例外

- [ ] **Step 1: 寫測試**

建立 `packages/runtime/test/keepalive.test.ts`：

```ts
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startKeepAlive } from '../src/keepalive';

describe('startKeepAlive', () => {
  it('開始時登記、定期更新、結束時取消', async () => {
    const sock = path.join(await mkdtemp(path.join(os.tmpdir(), 'ka-')), 'api.sock');
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url} ${body}`);
        res.statusCode = req.method === 'DELETE' ? 204 : 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));

    const keepAlive = await startKeepAlive(sock, 'run-1', 50);
    await new Promise((r) => setTimeout(r, 130));
    await keepAlive.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(calls[0]).toBe('PUT /v1/tasks/run-1 {"expire":"5m"}');
    expect(calls.filter((c) => c.startsWith('PUT')).length).toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)).toBe('DELETE /v1/tasks/run-1 ');
  });

  it('socket 不存在（本機開發）時不丟例外', async () => {
    const keepAlive = await startKeepAlive('/nonexistent/api.sock', 'run-2', 50);
    await expect(keepAlive.stop()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/keepalive.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/keepalive"`。

- [ ] **Step 3: 實作**

建立 `packages/runtime/src/keepalive.ts`：

```ts
import http from 'node:http';

export const KEEPALIVE_INTERVAL_MS = 120_000;

function call(socketPath: string, method: string, urlPath: string, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, host: 'sprite', path: urlPath, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

export async function startKeepAlive(
  socketPath: string,
  taskName: string,
  intervalMs = KEEPALIVE_INTERVAL_MS,
): Promise<{ stop(): Promise<void> }> {
  const taskPath = `/v1/tasks/${encodeURIComponent(taskName)}`;
  const refresh = () =>
    call(socketPath, 'PUT', taskPath, { expire: '5m' }).catch((e: Error) => {
      console.warn('[keepalive] 登記失敗', e.message);
    });

  await refresh();
  const timer = setInterval(refresh, intervalMs);
  return {
    stop: async () => {
      clearInterval(timer);
      await call(socketPath, 'DELETE', taskPath).catch(() => undefined);
    },
  };
}
```

- [ ] **Step 4: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/keepalive.test.ts
```

Expected: 2 個測試全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): Sprite 工作中登記"
```

---

### Task 10: 一次 run 的完整流程與 HTTP 服務

**Files:**
- Create: `packages/runtime/src/run.ts`、`packages/runtime/src/server.ts`、`packages/runtime/src/main.ts`
- Create: `packages/runtime/.env.example`
- Test: `packages/runtime/test/server.test.ts`

**Interfaces:**
- Consumes: Task 3–9 的所有函式
- Produces:
  - `RUN_TIMEOUT_MS = 15 * 60_000`
  - `type RunDeps = { db: Db; model: LanguageModel; config: Config }`
  - `startRun(deps: RunDeps, req: { threadId: string; text: string }): Promise<Response>`：可能丟 `NotFoundError`、`RunConflictError`、其他錯誤
  - `textOf(m: UIMessage): string`、`toolEvents(m: UIMessage): { tool: string; state: string }[]`
  - `createApp(deps: RunDeps): Hono`：`GET /health` → `{ ok: true, project_id }`；`POST /chat` body `{ thread_id: uuid, text: string }`，成功回 UI message stream（SSE），錯誤回 `400`／`404`／`409`／`500` 與 `{ error }`
  - 計畫 2 會修改 `run.ts` 的 `prepareRootAgent`，讓 2 位以上顧問時改用主管

- [ ] **Step 1: 寫整合測試**

建立 `packages/runtime/test/server.test.ts`：

```ts
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server';
import type { Db } from '../src/db';
import {
  seedConsultant, seedProject, seedTemplate, seedThread, seedUser, testConfig, testDb, tmpRoots,
  uploadSkillsZip, waitFor, type ConsultantFields,
} from './helpers';
import { failingModel, mockModel, promptText, textTurn, toolTurn } from './mock-model';
import type { LanguageModel } from 'ai';

const db = testDb();

async function seedEnv(fields: ConsultantFields = {}) {
  const creatorId = await seedUser(db);
  const ownerId = await seedUser(db);
  const templateId = await seedTemplate(db, creatorId);
  const projectId = await seedProject(db, ownerId);
  const threadId = await seedThread(db, projectId);
  const consultantId = await seedConsultant(db, projectId, { template_id: templateId, ...fields });
  const roots = await tmpRoots();
  return { creatorId, templateId, projectId, threadId, consultantId, roots, config: testConfig(projectId, roots) };
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitForRunDone(db: Db, threadId: string) {
  return waitFor(async () => {
    const { data } = await db.from('runs').select('*').eq('thread_id', threadId).neq('status', 'running')
      .order('started_at', { ascending: false }).limit(1);
    return data?.[0];
  });
}

async function messagesOf(threadId: string) {
  const { data } = await db.from('messages').select('*').eq('thread_id', threadId).order('created_at');
  return data!;
}

function app(env: Awaited<ReturnType<typeof seedEnv>>, model: LanguageModel) {
  return createApp({ db, model, config: env.config });
}

describe('GET /health', () => {
  it('回傳專案 id', async () => {
    const env = await seedEnv();
    const res = await app(env, mockModel()).request('/health');
    expect(await res.json()).toEqual({ ok: true, project_id: env.projectId });
  });
});

describe('POST /chat', () => {
  it('單一顧問：串流回覆，寫入 user、final、run、usage', async () => {
    const env = await seedEnv();
    const res = await post(app(env, mockModel(textTurn('你好，我是法務顧問'))), { thread_id: env.threadId, text: '請問合約風險' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('你好，我是法務顧問');

    const run = await waitForRunDone(db, env.threadId);
    expect(run.status).toBe('succeeded');
    const msgs = await messagesOf(env.threadId);
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'final']);
    expect(msgs[0]).toMatchObject({ content: '請問合約風險', speaker_instance_id: null });
    expect(msgs[1]).toMatchObject({ content: '你好，我是法務顧問', speaker_instance_id: env.consultantId });
    expect(msgs[1].ui_message.role).toBe('assistant');

    const usageRows = await waitFor(async () => {
      const { data } = await db.from('usage_events').select('*').eq('run_id', run.id);
      return data?.length ? data : undefined;
    });
    expect(usageRows[0]).toMatchObject({
      project_id: env.projectId, instance_id: env.consultantId, template_id: env.templateId, creator_id: env.creatorId,
      prompt_tokens: 10, output_tokens: 5, cached_tokens: 2, thought_tokens: 1,
    });
  });

  it('執行工具：寫檔成功，final 的 tool_events 有紀錄', async () => {
    const env = await seedEnv();
    const model = mockModel(toolTurn('write_file', { path: 'memo.md', content: '重點' }), textTurn('寫好了'));
    await (await post(app(env, model), { thread_id: env.threadId, text: '幫我記重點' })).text();
    await waitForRunDone(db, env.threadId);
    await expect(stat(path.join(env.roots.agentsRoot, env.consultantId, 'memo.md'))).resolves.toBeTruthy();
    const final = (await messagesOf(env.threadId)).find((m) => m.kind === 'final');
    expect(final.content).toBe('寫好了');
    expect(final.tool_events).toEqual([{ tool: 'write_file', state: 'output-available' }]);
  });

  it('第二次對話帶入之前的問答', async () => {
    const env = await seedEnv();
    const model = mockModel(textTurn('第一個回答'), textTurn('第二個回答'));
    const a = app(env, model);
    await (await post(a, { thread_id: env.threadId, text: '第一個問題' })).text();
    await waitForRunDone(db, env.threadId);
    await (await post(a, { thread_id: env.threadId, text: '第二個問題' })).text();
    await waitFor(async () => ((await messagesOf(env.threadId)).length === 4 ? true : undefined));
    await waitFor(async () => {
      const { data } = await db.from('runs').select('id').eq('thread_id', env.threadId).eq('status', 'running');
      return data?.length === 0 ? true : undefined;
    });
    const prompt = promptText(model, 1);
    expect(prompt).toContain('第一個問題');
    expect(prompt).toContain('第一個回答');
    expect(prompt).toContain('第二個問題');
  });

  it('skills 會同步到工作目錄，prompt 帶出 SKILL.md 路徑', async () => {
    const zipPath = await uploadSkillsZip(db, { 'contract/SKILL.md': '# 審合約' });
    const env = await seedEnv({ skills_zip_path: zipPath, skills: [{ name: '審合約', description: '檢查風險', path: 'contract' }] });
    const model = mockModel(textTurn('好'));
    await (await post(app(env, model), { thread_id: env.threadId, text: '看合約' })).text();
    await waitForRunDone(db, env.threadId);
    const skillFile = path.join(env.roots.agentsRoot, env.consultantId, 'skills', 'contract', 'SKILL.md');
    await expect(stat(skillFile)).resolves.toBeTruthy();
    expect(promptText(model)).toContain(skillFile);
  });

  it('瀏覽器中途斷線，run 仍會跑完並寫入 final', async () => {
    const env = await seedEnv();
    const res = await post(app(env, mockModel(textTurn('這是一段比較長的回答', 30))), { thread_id: env.threadId, text: '問題' });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    const run = await waitForRunDone(db, env.threadId);
    expect(run.status).toBe('succeeded');
    const final = (await messagesOf(env.threadId)).find((m) => m.kind === 'final');
    expect(final.content).toBe('這是一段比較長的回答');
  });

  it('模型出錯：run 標成 failed 並保留錯誤訊息', async () => {
    const env = await seedEnv();
    const res = await post(app(env, failingModel('模型掛了')), { thread_id: env.threadId, text: '問題' });
    expect(res.status).toBe(200);
    await res.text();
    const run = await waitForRunDone(db, env.threadId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('模型掛了');
  });

  it('MCP 啟動失敗不影響 run，prompt 告知 agent', async () => {
    const env = await seedEnv({ mcp_servers: [{ name: 'broken', transport: 'stdio', command: '/nonexistent/cmd' }] });
    const model = mockModel(textTurn('照常回答'));
    await (await post(app(env, model), { thread_id: env.threadId, text: '問題' })).text();
    expect((await waitForRunDone(db, env.threadId)).status).toBe('succeeded');
    expect(promptText(model)).toContain('目前無法使用');
  });

  it('同一串對話已有 run 在跑：回 409', async () => {
    const env = await seedEnv();
    await db.from('runs').insert({ thread_id: env.threadId });
    const res = await post(app(env, mockModel(textTurn('x'))), { thread_id: env.threadId, text: '問題' });
    expect(res.status).toBe(409);
  });

  it('對話不屬於這個專案：回 404', async () => {
    const env = await seedEnv();
    const other = await seedEnv();
    const res = await post(app(env, mockModel(textTurn('x'))), { thread_id: other.threadId, text: '問題' });
    expect(res.status).toBe(404);
  });

  it('body 格式錯誤：回 400', async () => {
    const env = await seedEnv();
    const res = await post(app(env, mockModel()), { thread_id: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('專案沒有顧問：回 500，run 標成 failed', async () => {
    const env = await seedEnv();
    await db.from('agent_instances').delete().eq('project_id', env.projectId);
    const res = await post(app(env, mockModel()), { thread_id: env.threadId, text: '問題' });
    expect(res.status).toBe(500);
    const run = await waitForRunDone(db, env.threadId);
    expect(run).toMatchObject({ status: 'failed', error: '專案裡還沒有任何顧問' });
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/server.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/server"`。

- [ ] **Step 3: 實作 run 流程**

建立 `packages/runtime/src/run.ts`：

```ts
import {
  createUIMessageStreamResponse, generateId, readUIMessageStream,
  type LanguageModel, type UIMessage, type UIMessageChunk,
} from 'ai';
import { buildConsultant, type BuiltAgent } from './agents/build';
import type { Config } from './config';
import type { Db } from './db';
import { errorText } from './errors';
import { startKeepAlive } from './keepalive';
import { groupSecrets, loadInstances, loadSecrets } from './project-store';
import {
  assertThreadInProject, createRun, finishRun, insertMessage, loadHistory, type RunResult,
} from './run-store';
import { syncSharedFiles, syncSkills } from './sync';
import { usageRecorder } from './usage';

export const RUN_TIMEOUT_MS = 15 * 60_000;

export type RunDeps = { db: Db; model: LanguageModel; config: Config };

type PreparedRoot = { rootId: string; streamUI: BuiltAgent['streamUI']; close: () => Promise<void> };

export function textOf(m: UIMessage): string {
  return m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

export function toolEvents(m: UIMessage): { tool: string; state: string }[] {
  return m.parts.flatMap((p) => {
    if (p.type === 'dynamic-tool') return [{ tool: p.toolName, state: p.state }];
    if (p.type.startsWith('tool-')) return [{ tool: p.type.slice('tool-'.length), state: (p as { state: string }).state }];
    return [];
  });
}

function hasContent(m: UIMessage | undefined): m is UIMessage {
  return !!m && m.parts.some((p) => p.type === 'text' || p.type === 'dynamic-tool' || p.type.startsWith('tool-'));
}

async function prepareRootAgent(deps: RunDeps, runId: string): Promise<PreparedRoot> {
  const { db, config, model } = deps;
  const instances = await loadInstances(db, config.PROJECT_ID);
  const consultants = instances.filter((i) => i.role === 'consultant');
  if (consultants.length === 0) throw new Error('專案裡還沒有任何顧問');
  if (consultants.length > 1) throw new Error('多顧問模式尚未實作');

  const sharedFiles = await syncSharedFiles(db, config.PROJECT_ID, config.SHARED_ROOT);
  for (const i of consultants) await syncSkills(db, config.AGENTS_ROOT, i);
  const secrets = await loadSecrets(db, config.PROJECT_ID);

  const root = consultants[0];
  const built = await buildConsultant({
    db, model, config, instance: root, sharedFiles,
    secrets: groupSecrets(secrets, root.id),
    onStepEnd: usageRecorder({ db, projectId: config.PROJECT_ID, runId, instance: root }),
  });
  return { rootId: root.id, streamUI: built.streamUI, close: built.close };
}

async function consumeToEnd(
  stream: ReadableStream<UIMessageChunk>,
): Promise<{ final: UIMessage | undefined; failure: string | undefined }> {
  let failure: string | undefined;
  const watched = stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'error') failure = chunk.errorText;
        if (chunk.type === 'abort') failure ??= 'run 已中止';
        controller.enqueue(chunk);
      },
    }),
  );
  let final: UIMessage | undefined;
  try {
    for await (const m of readUIMessageStream({ stream: watched })) final = m;
  } catch (e) {
    failure ??= errorText(e);
  }
  return { final, failure };
}

export async function startRun(deps: RunDeps, req: { threadId: string; text: string }): Promise<Response> {
  const { db, config } = deps;
  await assertThreadInProject(db, req.threadId, config.PROJECT_ID);
  const runId = await createRun(db, req.threadId);

  const keepAlive = await startKeepAlive(config.SPRITE_API_SOCK, `run-${runId}`);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);
  let closeAgent: (() => Promise<void>) | undefined;
  const finish = async (result: RunResult) => {
    clearTimeout(timer);
    await closeAgent?.().catch(() => undefined);
    await finishRun(db, runId, result).catch((e) => console.error('[run] 無法更新 run 狀態', errorText(e)));
    await keepAlive.stop();
  };

  let uiStream: ReadableStream<UIMessageChunk>;
  let rootId: string;
  try {
    const history = await loadHistory(db, req.threadId);
    await insertMessage(db, {
      thread_id: req.threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: req.text,
      ui_message: { id: generateId(), role: 'user', parts: [{ type: 'text', text: req.text }] },
    });
    const root = await prepareRootAgent(deps, runId);
    closeAgent = root.close;
    rootId = root.rootId;
    uiStream = await root.streamUI({
      messages: [...history, { role: 'user', content: req.text }],
      abortSignal: abort.signal,
    });
  } catch (e) {
    await finish({ status: 'failed', error: errorText(e) });
    throw e;
  }

  const [forClient, forServer] = uiStream.tee();
  void (async () => {
    const { final, failure } = await consumeToEnd(forServer);
    let saveError: string | undefined;
    if (hasContent(final)) {
      await insertMessage(db, {
        thread_id: req.threadId, run_id: runId, speaker_instance_id: rootId, kind: 'final',
        content: textOf(final), ui_message: final, tool_events: toolEvents(final),
      }).catch((e) => { saveError = `無法儲存回覆：${errorText(e)}`; });
    }
    const error = failure ?? saveError ?? (abort.signal.aborted ? 'run 超過 15 分鐘' : undefined);
    await finish(error ? { status: 'failed', error } : { status: 'succeeded' });
  })();

  return createUIMessageStreamResponse({ stream: forClient });
}
```

- [ ] **Step 4: 實作 HTTP 服務與進入點**

建立 `packages/runtime/src/server.ts`：

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { errorText, NotFoundError, RunConflictError } from './errors';
import { startRun, type RunDeps } from './run';

const ChatBody = z.object({ thread_id: z.uuid(), text: z.string().min(1) });

export function createApp(deps: RunDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, project_id: deps.config.PROJECT_ID }));

  app.post('/chat', async (c) => {
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '請求格式錯誤' }, 400);
    try {
      return await startRun(deps, { threadId: parsed.data.thread_id, text: parsed.data.text });
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof RunConflictError) return c.json({ error: e.message }, 409);
      return c.json({ error: errorText(e) }, 500);
    }
  });

  return app;
}
```

建立 `packages/runtime/src/main.ts`：

```ts
import { createVertex } from '@ai-sdk/google-vertex';
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createDb } from './db';
import { failRunningRuns } from './run-store';
import { createApp } from './server';

const config = loadConfig();
const db = createDb(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY);
const vertex = createVertex({ apiKey: config.VERTEX_API_EXPRESS_MODE_KEY });

const cleaned = await failRunningRuns(db, config.PROJECT_ID, 'runtime 重啟');
if (cleaned > 0) console.warn(`[startup] 已把 ${cleaned} 個中斷的 run 標成 failed`);

serve({ fetch: createApp({ db, model: vertex(config.MODEL_ID), config }).fetch, port: config.PORT }, (info) => {
  console.log(`[runtime] listening on :${info.port}，專案 ${config.PROJECT_ID}`);
});
```

建立 `packages/runtime/.env.example`：

```bash
PROJECT_ID=00000000-0000-0000-0000-000000000000
SUPABASE_URL=
SUPABASE_SECRET_KEY=
VERTEX_API_EXPRESS_MODE_KEY=
# 本機開發用暫存目錄；Sprite 上用預設值 /agents、/shared
AGENTS_ROOT=/tmp/agenthub/agents
SHARED_ROOT=/tmp/agenthub/shared
```

- [ ] **Step 5: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/server.test.ts
```

Expected: 12 個測試全部 PASS。

- [ ] **Step 6: 跑全部測試與型別檢查**

```bash
supabase test db --linked
pnpm -F @agenthub/runtime test
pnpm -F @agenthub/runtime typecheck
```

Expected: pgTAP 全部 ok；Vitest 所有測試檔 PASS；typecheck 沒有錯誤。

- [ ] **Step 7: 用真的 Gemini 手動確認**

1. 用 service key 在雲端 Supabase 建一個 `@test.local` 使用者、範本、專案、對話、顧問（可以寫一支一次性的 tsx 腳本，跑完即可刪除）。
2. 執行（`PROJECT_ID` 換成剛建立的專案 id）：

```bash
cd packages/runtime
PROJECT_ID=<project id> AGENTS_ROOT=/tmp/agenthub/agents SHARED_ROOT=/tmp/agenthub/shared \
  node --env-file=../../.env --import tsx src/main.ts
```

4. 另一個終端機：

```bash
curl -N -X POST http://localhost:8080/chat \
  -H 'content-type: application/json' \
  -d '{"thread_id":"<thread id>","text":"你好，請自我介紹"}'
```

Expected: 看到 `data: {"type":"text-delta",...}` 的 SSE 串流，內容是 Gemini 的真實回覆；結束後 `runs` 表該筆為 `succeeded`、`usage_events` 有 token 數。確認完刪掉測試使用者。

- [ ] **Step 8: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): run 流程與 HTTP 服務"
```
