# 平台代管 MCP（3b）計畫 A：部署與呼叫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 創作者能用 API 建立代管 MCP 版本、上傳套件、部署、發布、下架與設定金鑰；租用時鎖定版本；閘道把請求轉到代管 Sprite。計畫 B 再做創作者頁面。

**Architecture:**
- 版本與金鑰存資料庫（只有 service role）。
- 部署分兩段，都由「讀取版本狀態」的請求推進：
  1. 代管 Sprite 上的部署腳本負責下載與安裝，狀態寫進檔案。
  2. Vercel 讀到「已安裝」後註冊服務、用 MCP `tools/list` 驗證。
- 創作者程式與安裝步驟一律以帳號 `mcp` 在沙盒執行（同 1-A 的做法：獨立掛載命名空間、遮住 Sprite 內部 API、`setpriv` 降權）。
- 閘道對 `hosted` 目標帶 Sprites token 通過 Fly 驗證，`X-AgentHub-Token` 帶創作者通行證。

**Tech Stack:** Supabase（Vault、Storage、RLS）、Next.js 16 route handlers 與 `after()`、`@fly/sprites`、Vitest、本機 PG16（migration 驗證）、Python／Node MCP 範本。

**Spec:** `docs/superpowers/specs/2026-10-15-hosted-mcp-3b-design.md`

## Global Constraints

- 範本 MCP 項目：`{ name, transport: 'remote', hosted: true }`，不填 `url`。
- 版本狀態：`pending`（等上傳）→ `deploying` → `ready`／`failed` → `published` → `retired`；另有 `disabled`（營運者停用）。
- 限制：
  - 每個代管 MCP 最多 3 個 `published`，加 1 個 `pending`／`deploying`。
  - 每位創作者的代管 Sprite 最多 10 台（`sprite_name` 不為空、狀態不是 `retired` 的版本）。
  - 部署最多 10 分鐘。
  - 套件最大 50 MB。
- Sprite 名稱：`agenthub-mcp-<版本 id 去連字號前 12 碼>`；`auth: 'sprite'`。
- 代管 Sprite 目錄：`/srv/agenthub-mcp/`（`app/` 程式、`deploy/` 狀態與日誌、`env.sh` 金鑰）。
- 注入程式的環境變數：創作者金鑰、`PORT=8080`、`AGENTHUB_MCP_URL`（`<sprite_url>/mcp`）、`AGENTHUB_PLATFORM_URL`。
- 程式必須在 `0.0.0.0:8080` 的 `/mcp` 提供 MCP streamable HTTP。
- `corepack pnpm`；Windows 既有 runtime 基準失敗 6 個；本計畫不改 runtime。
- 每個 Task 完成就在本機 commit。migration 套用、push、建立真實 Sprite 的驗收是對外動作，先告知使用者。

## Review Focus

1. 創作者程式（以 `mcp` 執行）讀得到部署腳本裡的一次性下載網址或 `.env` 以外的平台資料。→ Task 4 腳本測試、Task 8 真實 Sprite 驗收。
2. 安裝步驟（`pip install`／`npm install` 會執行套件內的任意程式）不是在沙盒裡跑。→ Task 4 測試安裝指令經過 `agenthub-mcp-run`。
3. 舊版本還有專案在用時被下架，那些專案的工具立刻壞掉。→ Task 3 測試下架前檢查 `remote_mcp_targets`。
4. 部署卡住（安裝永遠不結束、程式起不來）時版本永遠停在 `deploying`，又佔掉「部署中」的名額。→ Task 3 測試 10 分鐘逾時標 `failed`。
5. 範本有代管 MCP 卻沒有已發布版本時被租用或上架。→ Task 1、Task 2 測試。

---

## 檔案結構

```text
supabase/migrations/20261015000001_hosted_mcp.sql   兩張表、Vault 函式、remote_mcp_targets.hosted_version_id、hire_agent、bucket
supabase/tests/hosted_mcp.sql                        純 SQL 斷言（本機 PG／Dashboard 皆可跑，最後 rollback）
apps/web/lib/schemas.ts                              hosted: true
apps/web/lib/services/templates.ts                   上架前檢查代管 MCP；getOwnTemplate 匯出
apps/web/lib/services/projects.ts                    hireAgent 對「沒有已發布版本」回 409
apps/web/lib/hosted-sprite.ts                        代管 Sprite 的腳本、部署兩段、讀狀態、套用金鑰、MCP tools/list
apps/web/lib/services/hosted-mcp.ts                  版本與金鑰的業務規則、限制、狀態推進
apps/web/app/api/templates/[id]/hosted/[mcp]/...     API 路由
apps/web/lib/services/remote-mcp.ts、app/api/mcp/... 閘道支援 hosted
docs/creator/hosted-mcp.md、docs/creator/examples/hosted-python/、hosted-node/
apps/web/scripts/hosted-mcp.ts                       營運：disable、清理失敗版本
apps/web/scripts/probe-hosted-mcp.ts                 真實 Sprite 驗收
```

---

### Task 0：基準線

- [ ] 分支 `feat/hosted-mcp`（spec 已 commit）。
- [ ] 建 workspace 與 ledger，複製 `vt.sh`、`baseline-fails.txt`。
- [ ] 跑 web、runtime 測試與 typecheck，結果記入 ledger。

### Task 1：資料庫

**Files:** Create `supabase/migrations/20261015000001_hosted_mcp.sql`、`supabase/tests/hosted_mcp.sql`

- [ ] **Step 1：寫驗證 SQL**（`begin … rollback`，`do $$ … assert … $$`）：
  1. 建立創作者、範本（`mcp_servers` 含 `{"name":"fin","transport":"remote","hosted":true}`）、專案。
  2. 沒有 published 版本時，`hire_agent` 拋錯（`P0001`，訊息含 `hosted mcp fin`）。
  3. 新增版本 1（`published`）、版本 2（`ready`）後 `hire_agent` 成功：
     - `remote_mcp_targets` 一列，`kind='hosted'`、`hosted_version_id` = 版本 1、`url` 為 null。
     - 顧問設定 `mcp_servers` = `[{"name":"fin","transport":"remote"}]`。
  4. 版本 2 改 `published` 後再租一次 → 新顧問指向版本 2，舊顧問仍指向版本 1。
  5. 有顧問指向版本 1 時，`delete from hosted_mcp_versions where id = 版本 1` 失敗（FK restrict）。
  6. `set_hosted_mcp_secret(範本, 'fin', 'API_KEY', 'v1')` 後改成 `'v2'`，`get_hosted_mcp_secrets` 回 `[('API_KEY','v2')]`（更新，不重複）。
  7. `set role authenticated`：兩張新表都 42501；兩個函式不能執行（42501）。
- [ ] **Step 2：本機 PG 確認失敗**。沿用 1-C 的本機叢集與 Supabase 替身，另外補：
  - `vault.update_secret(id uuid, new_secret text)` 替身。
  - `storage.buckets` 已有。
- [ ] **Step 3：migration**

```sql
-- 子專案 3b：平台代管 MCP 的版本與創作者金鑰；只有 service role（Vercel）讀寫
create table public.hosted_mcp_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.agent_templates (id) on delete cascade,
  mcp_name text not null,
  version int not null,
  status text not null default 'pending'
    check (status in ('pending', 'deploying', 'ready', 'failed', 'published', 'retired', 'disabled')),
  bundle_path text not null,
  sprite_name text,
  sprite_url text,
  tools jsonb not null default '[]'::jsonb,
  log_tail text not null default '',
  deploy_started_at timestamptz,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (template_id, mcp_name, version)
);
alter table public.hosted_mcp_versions enable row level security;
revoke all on public.hosted_mcp_versions from anon, authenticated;

create table public.hosted_mcp_secrets (
  template_id uuid not null references public.agent_templates (id) on delete cascade,
  mcp_name text not null,
  key text not null,
  vault_secret_id uuid not null,
  primary key (template_id, mcp_name, key)
);
alter table public.hosted_mcp_secrets enable row level security;
revoke all on public.hosted_mcp_secrets from anon, authenticated;

alter table public.remote_mcp_targets
  add column hosted_version_id uuid references public.hosted_mcp_versions (id) on delete restrict;

create function public.set_hosted_mcp_secret(p_template_id uuid, p_mcp_name text, p_key text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select vault_secret_id into v_id from public.hosted_mcp_secrets
   where template_id = p_template_id and mcp_name = p_mcp_name and key = p_key;
  if v_id is null then
    v_id := vault.create_secret(p_value, 'hosted:' || p_template_id || ':' || p_mcp_name || ':' || p_key);
    insert into public.hosted_mcp_secrets values (p_template_id, p_mcp_name, p_key, v_id);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end $$;

create function public.get_hosted_mcp_secrets(p_template_id uuid, p_mcp_name text)
returns table (key text, value text) language sql security definer set search_path = '' as $$
  select s.key, d.decrypted_secret
    from public.hosted_mcp_secrets s join vault.decrypted_secrets d on d.id = s.vault_secret_id
   where s.template_id = p_template_id and s.mcp_name = p_mcp_name
   order by s.key
$$;

revoke execute on function public.set_hosted_mcp_secret(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.get_hosted_mcp_secrets(uuid, text) from public, anon, authenticated;
grant execute on function public.set_hosted_mcp_secret(uuid, text, text, text) to service_role;
grant execute on function public.get_hosted_mcp_secrets(uuid, text) to service_role;

insert into storage.buckets (id, name, public) values ('mcp-bundles', 'mcp-bundles', false)
on conflict (id) do nothing;
```

  接著 `create or replace function public.hire_agent(...)`：**整段複製** `20261014000001_remote_mcp.sql` 的版本，只改「寫入 `remote_mcp_targets`」那段：

```sql
  insert into public.remote_mcp_targets (instance_id, mcp_name, kind, url)
  select v_instance_id, s ->> 'name', 'self', s ->> 'url'
    from jsonb_array_elements(t.mcp_servers) s
   where s ->> 'transport' = 'remote' and coalesce((s ->> 'hosted')::boolean, false) = false;

  for v_server in select * from jsonb_array_elements(t.mcp_servers) loop
    if v_server ->> 'transport' = 'remote' and coalesce((v_server ->> 'hosted')::boolean, false) then
      select id into v_version_id from public.hosted_mcp_versions
       where template_id = t.id and mcp_name = v_server ->> 'name' and status = 'published'
       order by version desc limit 1;
      if v_version_id is null then
        raise exception 'hosted mcp % has no published version', v_server ->> 'name';
      end if;
      insert into public.remote_mcp_targets (instance_id, mcp_name, kind, hosted_version_id)
      values (v_instance_id, v_server ->> 'name', 'hosted', v_version_id);
    end if;
  end loop;
```

  - `declare` 加 `v_version_id uuid;`。
  - 「remote 型不留網址」的 `jsonb_build_object('name', …, 'transport', 'remote')` 不變，`hosted` 欄位也不會留在顧問設定。
- [ ] **Step 4：本機 PG 全部 migration 可套用、`hosted_mcp.sql` 通過**；並故意拿掉 FK 驗證它會失敗。
- [ ] **Step 5：Commit** — `feat(db): 平台代管 MCP 的版本、金鑰與租用鎖定版本`
- [ ] **Step 6（對外）**：請使用者在 Dashboard 執行 migration 與 `hosted_mcp.sql`。

### Task 2：範本設定與上架檢查

**Files:** Modify `apps/web/lib/schemas.ts`、`apps/web/lib/services/templates.ts`、`apps/web/lib/services/projects.ts`；Test `apps/web/test/schemas.test.ts`、`apps/web/test/hosted-mcp.test.ts`（新檔，本 Task 先放上架與租用相關測試）

- [ ] **Step 1：測試**
  - schema：
    - `{name:'fin', transport:'remote', hosted:true}` 合格。
    - `hosted:true` 又給 `url` → 「平台代管不需要網址」。
    - `hosted:false` 或省略時沒有 `url` → 「需要網址」（原規則）。
  - 上架：範本有代管 MCP 但沒有 `published` 版本 → 400「MCP「fin」還沒有已發布的版本」；直接插入一筆 `published` 版本後可以上架。
  - 租用：沒有 published 版本 → `hireAgent` 回 409「這位顧問的工具服務尚未發布」。
- [ ] **Step 2：** 確認失敗。
- [ ] **Step 3：實作**
  - schema：`hosted: z.boolean().optional()`。`superRefine` 的網址規則改成：
    - `remote && !hosted && !url` → 需要網址。
    - `remote && hosted && url` → 不需要網址。
    - https 檢查只在有 url 時做。
  - `templates.ts`：匯出 `getOwnTemplate`。`publishTemplate` 在 system prompt 檢查之後，對每個 `transport==='remote' && hosted` 的 MCP 查 `hosted_mcp_versions` 是否有 `published`，沒有就丟 400。
  - `projects.ts` 的 `hireAgent`：`error.message` 含 `hosted mcp` → `HttpError(409, '這位顧問的工具服務尚未發布')`。
- [ ] **Step 4：** 測試、typecheck、lint 通過。**Step 5：Commit** — `feat(web): 範本可以選擇平台代管 MCP，沒有已發布版本不能上架或租用`

### Task 3：版本與金鑰的業務規則

**Files:** Create `apps/web/lib/services/hosted-mcp.ts`；Test `apps/web/test/hosted-mcp.test.ts`

**Interfaces — Produces:**

```ts
export const HOSTED_LIMITS = { publishedPerMcp: 3, spritesPerCreator: 10, bundleBytes: 50 * 1024 * 1024, deployMs: 10 * 60_000 };
export type HostedVersion = {
  id: string; template_id: string; mcp_name: string; version: number; status: string;
  bundle_path: string; sprite_name: string | null; sprite_url: string | null; tools: unknown[]; log_tail: string;
  deploy_started_at: string | null; created_at: string; published_at: string | null;
};
export async function createVersion(db: Db, userId: string, templateId: string, mcpName: string): Promise<{ version: HostedVersion; signedUrl: string }>;
export async function startDeploy(db: Db, userId: string, versionId: string): Promise<HostedVersion>;  // pending → deploying（檢查已上傳、大小）
export async function syncVersion(db: Db, versionId: string, sprites: HostedSpriteOps, now?: number): Promise<HostedVersion>;
export async function publishVersion(db: Db, userId: string, versionId: string): Promise<HostedVersion>;
export async function retireVersion(db: Db, userId: string, versionId: string, sprites: HostedSpriteOps): Promise<HostedVersion>;
export async function setHostedSecrets(db: Db, userId: string, templateId: string, mcpName: string, secrets: Record<string, string>, sprites: HostedSpriteOps): Promise<void>;
export async function listVersions(db: Db, userId: string, templateId: string, mcpName: string): Promise<HostedVersion[]>;
/** 套件大小檢查；超過 50 MB 丟 HttpError(400) */
export function checkBundle(size: number | undefined): void;
/** 驗證 mcp.json 內容，回傳標準化設定；不合格丟 Error（訊息給創作者看） */
export function parseMcpJson(text: string): { runtime: 'python' | 'node'; start: string; install?: string };
```

`HostedSpriteOps` 由 Task 4 實作（這裡以介面注入，測試用假的）：

```ts
export type DeployState =
  | { phase: 'installing'; log: string }
  | { phase: 'installed'; start: string; log: string }
  | { phase: 'failed'; error: string; log: string };
export type HostedSpriteOps = {
  provision(version: HostedVersion, env: Record<string, string>, bundleUrl: string): Promise<{ spriteName: string; spriteUrl: string }>;
  readState(spriteName: string): Promise<DeployState>;
  startService(spriteName: string, start: string): Promise<void>;
  listTools(spriteUrl: string, creatorToken: string): Promise<{ name: string; description?: string }[]>;
  applyEnv(spriteName: string, env: Record<string, string>): Promise<void>;  // 改寫 env.sh 並重啟 mcp 服務
  destroy(spriteName: string): Promise<void>;
};
```

- [ ] **Step 1：寫測試**（雲端 DB；sprites 用假的物件記錄呼叫）
  1. `createVersion`：
     - 不是自己的範本 → 404。
     - MCP 不是代管 → 400。
     - 版本號從 1 遞增，回傳簽名上傳網址。
     - 已有 `pending`／`deploying` → 409「已有版本正在部署」。
     - 已有 3 個 `published` → 409「已發布 3 個版本」。
     - 創作者已有 10 台代管 Sprite → 409「代管 Sprite 已達 10 台上限」。
  2. `startDeploy`：
     - 還沒上傳 → 400「還沒有上傳套件」。
     - 超過 50 MB → 400（直接插入一個大檔的 metadata 不易，改測 `checkBundle(size)` 純函式）。
     - 成功 → `deploying` 並記 `deploy_started_at`。
  3. `syncVersion` 狀態推進：
     - `deploying` 且尚未 provision → 呼叫 `provision`。env 含金鑰、`PORT`、`AGENTHUB_MCP_URL`（sprite_url + `/mcp`）、`AGENTHUB_PLATFORM_URL`；寫入 sprite_name／sprite_url。
     - `readState` 回 `installing` → 維持 `deploying`，`log_tail` 更新。
     - `installed` → `startService` → `listTools`：有工具 → `ready` 並存 `tools`；空清單 → `failed`「沒有任何工具」。
     - `failed` → `failed`，`log_tail` 是錯誤與日誌最後 100 行。
     - `deploy_started_at` 超過 10 分鐘仍在 `deploying` → `failed`「部署逾時」。
  4. `publishVersion`：只有 `ready` 能發布（其他 → 409）。
  5. `retireVersion`：
     - 有 `remote_mcp_targets` 指向 → 409「還有專案在使用這個版本」。
     - 沒有 → 呼叫 `destroy`、狀態 `retired`。
  6. `setHostedSecrets`：
     - key 必須符合 `^[A-Z][A-Z0-9_]*$`，且不能是保留名稱（`PORT`、`AGENTHUB_MCP_URL`、`AGENTHUB_PLATFORM_URL`）。
     - 寫入後 `get_hosted_mcp_secrets` 讀得回。
     - 對每個 `ready`／`published` 版本呼叫 `applyEnv`，傳入的是新的完整 env。
- [ ] **Step 2：** 確認失敗。
- [ ] **Step 3：實作** `lib/services/hosted-mcp.ts`。重點：
  - 所有入口先 `getOwnTemplate(db, userId, templateId)`，並確認 `mcp_servers` 有 `{ name: mcpName, transport: 'remote', hosted: true }`，否則 400「這個 MCP 不是平台代管」。
  - 版本號：`select max(version)` + 1。`bundle_path = \`${templateId}/${mcpName}/${version}.zip\``。上傳網址用 `db.storage.from('mcp-bundles').createSignedUploadUrl(bundle_path, { upsert: true })`。
  - `startDeploy`：`db.storage.from('mcp-bundles').list(dir, { search: file })` 取得 `metadata.size`，交給 `checkBundle(size)`。
  - `hostedEnv(db, templateId, mcpName, spriteUrl)`：組 env（`rpc('get_hosted_mcp_secrets')` 加上三個平台變數）。
  - `syncVersion`：
    - 第一次 provision 時，下載網址用 `createSignedUrl(bundle_path, 900)`。
    - `listTools` 用的通行證：`signCreatorToken({ iss: env.platformUrl, aud: \`${spriteUrl}/mcp\`, sub: 'deploy-check', project_id: 'deploy-check', template_id }, env.mcpSigningKey)`。
  - `log_tail` 只留最後 100 行。
- [ ] **Step 4：** 測試、typecheck、lint 通過。**Step 5：Commit** — `feat(web): 代管 MCP 版本的建立、部署推進、發布、下架與金鑰`

### Task 4：代管 Sprite 的實際操作

**Files:** Create `apps/web/lib/hosted-sprite.ts`；Test `apps/web/test/hosted-sprite.test.ts`

**Interfaces — Produces:** `hostedSpriteName(versionId)`、`HOSTED_SETUP_SCRIPT`、`deployScript(bundleUrl)`、`envScript(env)`、`createHostedSpriteOps(): HostedSpriteOps`、`listToolsOver(fetchImpl, url, headers)`。

- [ ] **Step 1：寫測試**（純字串與假 Sprite 物件，同 `sprites.test.ts` 的 `installRuntime` 測試寫法）
  - `hostedSpriteName('123e4567-e89b-12d3-a456-426614174000')` = `agenthub-mcp-123e4567e89b`。
  - `HOSTED_SETUP_SCRIPT`：
    - 建立 `mcp` 帳號（`useradd`，不在 sudo 群組）。
    - 安裝 `/usr/local/bin/agenthub-mcp-run`（root 755）。
    - `/srv/agenthub-mcp/deploy` 為 `sprite` 擁有、700。
    - `/srv/agenthub-mcp/app` 由 `mcp` 擁有。
  - `agenthub-mcp-run` 的內容：
    - 重設 `PATH`、清除 `LD_*`。
    - 把 `/.sprite/api.sock` bind 成 `/dev/null`。
    - 以 `setpriv --reuid=mcp --regid=mcp --init-groups --inh-caps=-all` 執行。
    - 執行前 `set -a; . /srv/agenthub-mcp/env.sh; set +a`（env.sh 為 `mcp` 擁有、400）。
  - `deployScript(url)`：
    - 下載（`curl -fsSL`）到 deploy 目錄，`unzip` 到 `app/`，`chown -R mcp:mcp app`（解壓後、執行任何創作者程式之前）。
    - `mcp.json` 用 `python3 -c` 解析並驗證 `runtime` ∈ {python, node}、`start` 非空。
    - **安裝指令經 `sudo -n unshare --mount --propagation private -- /usr/local/bin/agenthub-mcp-run`**（Review Focus 2）：Python 是 `python3 -m venv .venv && .venv/bin/pip install -r <install>`；Node 是 `npm ci || npm install`。
    - 每步寫 `deploy/state.json`；全程 `timeout 540`。
    - 腳本與下載網址只存在 `deploy/`（700，`mcp` 進不去，Review Focus 1）。
  - `envScript({ API_KEY: "a'b" })` → `API_KEY='a'\''b'`，每行一個，單引號跳脫正確。
  - `createHostedSpriteOps().provision`（假 Sprite）：
    - 依序：建立 Sprite → 執行 setup → 寫 `env.sh` 與部署腳本 → 以服務 `deploy` 啟動。
    - 回傳 Sprite 名稱與 URL。
  - `startService`：服務 `mcp`，cmd `sudo`，args 為 `-n unshare --mount --propagation private -- /usr/local/bin/agenthub-mcp-run /bin/bash -c 'cd /srv/agenthub-mcp/app && exec <start>'`，`httpPort: 8080`。
  - `listToolsOver`（本機假 MCP server）：
    - 依序送 `initialize`、`notifications/initialized`、`tools/list`。
    - 帶回 `mcp-session-id`。
    - 支援 JSON 與 SSE 兩種回應。
    - 標頭含 `X-AgentHub-Token` 與 `Authorization: Bearer <Sprites token>`。
- [ ] **Step 2：** 確認失敗。
- [ ] **Step 3：實作**
  - 腳本內容依上面的測試寫，風格比照 `lib/sprites.ts` 的 `SANDBOX_WRAPPER_SCRIPT`：陣列 join、指令用絕對路徑、`set -eu`。
  - `readState` 用 `sprite.execFile('bash', ['-lc', 'cat /srv/agenthub-mcp/deploy/state.json; echo; tail -n 100 /srv/agenthub-mcp/deploy/log.txt'])` 解析。
  - `applyEnv` 改寫 `env.sh`（以 `mcp` 擁有、400）後 `restartService('mcp')`。
  - `destroy` 沿用 `destroyProjectSprite`（名稱以 `agenthub-` 開頭）。
- [ ] **Step 4：** 測試、typecheck、lint 通過。**Step 5：Commit** — `feat(web): 代管 Sprite 的建立、沙盒安裝、服務啟動與工具清單驗證`

### Task 5：API 路由

**Files:** Create（皆在 `apps/web/app/api/templates/[id]/hosted/[mcp]/` 下）：
- `versions/route.ts`：GET 列表、POST 建立。
- `versions/[versionId]/route.ts`：GET 讀狀態，`deploying` 時呼叫 `syncVersion`，`maxDuration = 300`；DELETE 下架。
- `versions/[versionId]/deploy/route.ts`：POST，`startDeploy` 後 `after(() => syncVersion(...))`。
- `versions/[versionId]/publish/route.ts`：POST。
- `secrets/route.ts`：PUT，body `{ secrets: Record<string,string> }`。

Test `apps/web/test/hosted-mcp-routes.test.ts`。

- [ ] **Step 1：測試**：
  - 每個路由沒登入 → 401。
  - 不是範本擁有者 → 404。
  - POST versions 回 `{ version, signedUrl }`。
  - PUT secrets 的 body 驗證（值必須是字串）。
  - 路由以 `createHostedSpriteOps()` 注入真實操作，但測試透過 `vi.mock('@/lib/hosted-sprite')` 換成假的。
- [ ] **Step 2–4：** 實作與通過。**Step 5：Commit** — `feat(web): 代管 MCP 的 API`

### Task 6：閘道支援 hosted

**Files:** Modify `apps/web/lib/services/remote-mcp.ts`、`apps/web/app/api/mcp/[instanceId]/[name]/route.ts`；Test `apps/web/test/remote-mcp.test.ts`

- [ ] **Step 1：測試**（雲端 DB；本機 `node:http` 假伺服器當作代管 Sprite，版本的 `sprite_url` 指向它）：
  - 租用指向 `published` 版本的顧問。經閘道呼叫時，假伺服器收到：
    - `authorization: Bearer <FLY_SPRITES_TOKEN 的測試值>`。
    - `x-agenthub-token` 的 `aud` = `sprite_url + '/mcp'`。
    - 路徑 `/mcp`。
    - 用量照常記錄。
  - 版本 `disabled` → 503「這個工具服務已被暫停」。
  - 版本 `retired` → 404。
  - 假伺服器先回 503 一次再回 200 → 閘道重試後成功（只對 hosted 重試，最多 2 次、間隔 1 秒，測試把間隔注入為 0）。
- [ ] **Step 2：** 確認失敗。
- [ ] **Step 3：實作**
  - `resolveRemoteTarget`：
    - `select kind, url, hosted_version_id`。
    - `kind = 'hosted'` 時再查版本的 `status, sprite_url`：`disabled` → 503；`retired`／沒有 `sprite_url` → 404。
    - 回傳 `{ url: sprite_url + '/mcp', templateId, creatorId, edgeToken: env.spritesToken }`。
  - `forwardToCreator` 加參數 `opts?: { edgeToken?: string; retries?: number; retryDelayMs?: number }`：
    - 有 `edgeToken` 時，`authorization` 用它，`x-agenthub-token` 仍是創作者通行證。
    - 對 502／503 重試。
- [ ] **Step 4：** 既有閘道測試與新測試全部通過。**Step 5：Commit** — `feat(web): 閘道轉送到平台代管的 MCP`

### Task 7：範本、文件、營運腳本

**Files:**
- `docs/creator/examples/hosted-python/`：`mcp.json`、`requirements.txt`（`mcp==2.3.0`、`pyjwt[crypto]>=2.15`）、`server.py`。
- `docs/creator/examples/hosted-node/`：`mcp.json`、`package.json`、`server.mjs`。
- `docs/creator/hosted-mcp.md`。
- `apps/web/scripts/hosted-mcp.ts`。
- Test `apps/web/test/hosted-examples.test.ts`。

- [ ] **Step 1：測試**：
  - 兩個範本的 `mcp.json` 都通過 `parseMcpJson`（Task 3 匯出的純函式）。
  - `server.py`／`server.mjs` 含 `X-AgentHub-Token` 驗證，`aud` 取自 `AGENTHUB_MCP_URL`。
  - `hosted-mcp.ts` 的參數解析：`disable <id>`、`cleanup-failed`（刪除 `failed` 超過 24 小時的 Sprite，`sprite_name` 改 null）。
- [ ] **Step 2–4：** 實作與通過。
  - Python 範本以 mcp 2.x 的 `MCPServer`（`stateless_http=True`、`json_response=True`），外層 ASGI middleware 驗證通行證（同 fintech `mcp-server/auth.py` 的寫法），一個示範工具 `echo`。
  - Node 範本用官方 `@modelcontextprotocol/sdk` 的 streamable HTTP（stateless），以 `jose` 驗證，一個示範工具 `echo`。
  - 文件寫明：套件格式、環境變數、限制、版本與發布、金鑰、費用（休眠時程式暫停）。
- [ ] **Step 5：Commit** — `docs: 平台代管 MCP 的範本、創作者文件與營運腳本`

### Task 8：真實 Sprite 驗收與上線（對外動作先告知使用者）

**Files:** Create `apps/web/scripts/probe-hosted-mcp.ts`

- [ ] **Step 1：驗收腳本**：
  1. 以測試帳號建立範本與 `hosted` MCP。
  2. 把 `docs/creator/examples/hosted-python` 壓成 zip 上傳，部署（直接呼叫 service 函式與真的 `createHostedSpriteOps()`），反覆 `syncVersion` 直到 `ready`。
  3. 檢查：
     - 工具清單含 `echo`。
     - 以 `mcp` 帳號執行 `cat /srv/agenthub-mcp/deploy/deploy.sh` 失敗（讀不到下載網址）。
     - 假程式印出收到的標頭時沒有 `authorization`。
     - `setHostedSecrets` 後重啟，`echo` 工具回傳的環境變數已更新（範本的 `echo` 支援回傳指定環境變數是否存在）。
  4. Node 範本再跑一次。
  5. 結束時下架並刪除範本，確認沒有殘留 `agenthub-mcp-` Sprite。
- [ ] **Step 2：** 跑驗收（建立真實 Sprite，先告知使用者）。全部通過。
- [ ] **Step 3：** 請使用者在 Dashboard 套用 migration（若 Task 1 Step 6 尚未做）。
- [ ] **Step 4：** finishing-a-development-branch → 合併、push `main`、確認 Vercel 部署成功。
- [ ] **Step 5：** 正式環境：用 API 建立一個代管測試顧問並發布，從新專案經平台呼叫一次，查 `mcp_usage`，最後下架、刪除。
- [ ] **Step 6：** 更新 `docs/security-model.md`（3b 狀態與權限表加兩張表）、CLAUDE.md、記憶。
