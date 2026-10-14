# runtime 只限自己專案的資料庫權限（子專案 1-C）技術規格

- 日期：2026-10-14
- 狀態：設計已逐段確認，待最終審閱
- 目標：Sprite 上不再存放任何平台金鑰。runtime 以「專案專用的 Supabase 帳號」取得通行證存取資料庫，由 RLS 依 `docs/security-model.md` 第 4 節的權限表把關；模型改由 Vercel 代理呼叫。
- 取代：`2026-10-13-platform-key-isolation-design.md` 第 3 節原本的做法（Vercel 自簽 JWT 加自訂資料庫角色）。原做法需要 Supabase 簽章私鑰，而這個專案的 ES256 私鑰無法匯出；若改成匯入自己的私鑰，又要把所有使用者登入改用我們持有的私鑰簽章。
- 參考：RiluTrip（`D:\ChillTours`）的做法。每次存取資料庫都帶 Supabase 發給該身分的通行證，由 RLS 判斷能做什麼，伺服器不拿萬能鑰匙。

---

## 0. 現況

- 每台 Sprite 的 `~/agenthub/.env` 有 `SUPABASE_SECRET_KEY`（整個資料庫的最高權限）與 `VERTEX_API_EXPRESS_MODE_KEY`。
- 子專案 1-A、2 之後，沙盒裡的 agent 拿不到這兩把金鑰；但 runtime 程式本身持有。runtime 若有漏洞或某台 Sprite 被攻破，影響的是全平台。
- 資料表全部開啟 RLS 且沒有 policy。網站（Vercel）用 secret key 存取；瀏覽器不直接連資料庫。

## 1. 決策紀錄

| 項目 | 決定 |
|---|---|
| runtime 的身分 | 每個專案在 Supabase Auth 有一個系統帳號；`app_metadata.agenthub_runtime_project` = 專案 id |
| 為什麼不用使用者本人的通行證 | runtime 要讀創作者的 system prompt、skill。若讓使用者的通行證有這些權限，使用者在瀏覽器就能直接讀走，違反市集承諾 |
| 通行證由誰取得 | Vercel（持有 secret key）在轉送對話時取得，跟著對話交給 runtime |
| 權限把關 | 資料庫 RLS ＋欄位層級 grant，條件取自通行證的 `app_metadata`（使用者無法修改） |
| 模型 | Vercel 代理呼叫 Vertex，驗證子專案 3a 的專案通行證 |
| 通行證效期 | 沿用 Supabase 設定（目前 1 小時）；run 最長 15 分鐘 |

## 2. runtime 帳號

### 2.1 建立與保存

- 建立專案時（`createProject` 之後、佈建 Sprite 之前），Vercel 以 admin API 建立帳號：
  - email：`runtime+<專案 id>@agenthub.internal`，`email_confirm: true`（不寄信）
  - password：32 bytes 隨機
  - `app_metadata`：`{ "agenthub_runtime_project": "<專案 id>" }`
- 新表 `project_runtime_accounts`：`project_id`（PK，FK projects，on delete cascade）、`user_id`、`password_secret_id`（Vault）、`access_token`、`refresh_token`、`expires_at`。RLS 開啟、不設 policy，並 `revoke all from anon, authenticated`，只有 secret key 能讀寫。
- 密碼存 Vault，`password_secret_id` 指向它。
- 刪除專案時一併刪除 Auth 帳號（`auth.admin.deleteUser`）。
- `handle_new_user` trigger：帳號帶 runtime 標記時不建立 `profiles`。
- 既有專案：腳本 `apps/web/scripts/backfill-runtime-accounts.ts` 逐一補建，可重複執行（已有帳號就跳過）。

### 2.2 取得通行證（`apps/web/lib/runtime-session.ts`）

`runtimeAccessToken(db, projectId): Promise<string>`：

1. 讀 `project_runtime_accounts`。`access_token` 剩餘效期 ≥ 20 分鐘就直接回傳。
2. 否則用 `refresh_token` 換新（`auth.refreshSession`），寫回新的 token 與 `expires_at`。
3. 換不成（refresh token 失效）才用密碼登入（`signInWithPassword`），寫回。
4. 都失敗 → 丟錯；chat 路由回 503「agent 環境暫時無法連線資料庫」。

目的：避開 Supabase 的登入次數限制（登入與驗證預設每 IP 每 5 分鐘 30 次）。活躍專案大約每 40 分鐘才需要換一次。

同一專案兩個對話同時換新時，以「最後寫入者為準」。Supabase 允許 refresh token 在短時間內重複使用（reuse interval），兩個請求都能拿到可用的通行證。

### 2.3 傳給 runtime

- `forwardChat` 多帶一個標頭 `x-agenthub-db-token: <access_token>`。子專案 3a 的 `x-agenthub-token`（專案通行證）照舊。
- runtime 收到後，以 `createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { global: { headers: { Authorization: Bearer <token> } } })` 建立這次 run 專用的 client。run 結束即丟棄，不寫入任何檔案。
- 沒有 `x-agenthub-db-token` 的 `/chat` 一律回 401。

### 2.4 runtime 帳號不能當網站使用者

- `currentUser()` 取得使用者後，`app_metadata.agenthub_runtime_project` 有值就視為未登入。所有 `/api/*`、頁面都拒絕。
- runtime 帳號在 Supabase 的其他用途（例如自行改密碼、更新 email）：權限表外的動作一律沒有 policy，資料庫層拒絕。Auth 層的自助操作只影響這個系統帳號本身，下次換新時密碼登入失敗就回 503。這種情況要重設帳號，記錄在 6. 錯誤處理。

## 3. 資料庫權限

### 3.1 判斷函式

```sql
create function public.runtime_project() returns uuid
language sql stable set search_path = '' as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'agenthub_runtime_project', '')::uuid
$$;
```

所有 policy 都以 `public.runtime_project()` 比對資料所屬專案；一般使用者的通行證沒有這個欄位，函式回 `null`，比對一律失敗。

### 3.2 grant 與 policy

先 `revoke all on all tables in schema public from anon, authenticated`，並把 default privileges 改成新表不自動 grant，之後逐表開放給 `authenticated`。`service_role` 不受影響。

| 表 | grant（`authenticated`） | policy（皆限 `runtime_project()`） |
|---|---|---|
| `agent_instances` | select（runtime 用到的欄位） | `project_id = runtime_project()` |
| `agent_templates` | select (`id`, `creator_id`) | `id in (select template_id from agent_instances where project_id = runtime_project())` |
| `threads` | select (`id`, `project_id`) | `project_id = runtime_project()` |
| `runs` | select (`id`, `thread_id`, `status`)、insert (`thread_id`)、update (`status`, `error`, `finished_at`) | `thread_id in (自己專案的 threads)` |
| `messages` | select (`id`, `thread_id`, `run_id`, `kind`, `content`, `created_at`)、insert（runtime 寫入的欄位）、update (`content`, `ui_message`, `tool_events`, `updated_at`)、delete | select／insert：自己專案的 thread。update：`kind = 'final'` 且所屬 run 為 `running`。delete：同 update，且 `content = ''` |
| `memories` | select、insert | `project_id = runtime_project()` |
| `usage_events` | insert | with check `project_id = runtime_project()` |
| 其他表（`profiles`、`projects`、`instance_secrets`、`remote_mcp_targets`、`mcp_usage`、`project_runtime_accounts`…） | 無 | 無 |

- `get_project_secrets(p_project_id)`：維持 `security definer`，開放 `authenticated` 執行，函式開頭檢查 `p_project_id = runtime_project()`，不符就丟錯。
- Storage（`storage.objects`）：
  - `skills`：select，條件 `name in (select skills_zip_path from agent_instances where project_id = runtime_project())`。
  - `project-files`：select，條件 `name like runtime_project()::text || '/%'`。
- 實作時以 runtime 的實際查詢逐一核對欄位清單（`project-store.ts`、`run-store.ts`、`sync.ts`、`tools/memory.ts`、`usage.ts`），並同步更新 `docs/security-model.md` 第 4 節。

### 3.3 為什麼租用者讀不到創作者內容

- 每條 policy 都要求通行證帶 runtime 標記；`app_metadata` 只有 service role 能改。
- runtime 通行證只存在 `project_runtime_accounts`（只有 secret key 讀得到）與 runtime 程式的記憶體（沙盒讀不到，子專案 1-A）。
- 網站仍以 secret key 存取，畫面上顯示的內容不變（例如公開範本頁照樣不露出 prompt）。

## 4. runtime 的改動

- `config.ts`：移除 `SUPABASE_SECRET_KEY`、`VERTEX_API_EXPRESS_MODE_KEY`；新增 `SUPABASE_PUBLISHABLE_KEY`。`PLATFORM_URL` 改為必填（模型代理需要）。
- `main.ts`：開機時不再連資料庫。原本開機時把遺留的 `running` run 標成失敗，改到 `startRun`：取得 client 後，先把本專案「狀態為 running、但不在這個程式記憶體中的 run」標成失敗，再建立新 run。
- `server.ts`、`run.ts`：每次 `/chat` 用 `x-agenthub-db-token` 建立 client，取代全域的 `deps.db`。`RunDeps` 改成接收「依 token 建立 client」的函式，測試可注入。
- 模型：`createVertex` 的 `baseURL` 指向 `${PLATFORM_URL}/api/runtime/model`，標頭帶 `x-agenthub-token`（專案通行證）。

## 5. 模型代理（`apps/web/app/api/runtime/model/[...path]/route.ts`）

- 驗證 `x-agenthub-token`（`verifyProjectToken`，子專案 3a）。不符 → 401。
- 把請求轉給 Vertex express 端點（路徑與 query 照傳），附上 `VERTEX_API_EXPRESS_MODE_KEY`，回應串流原樣回傳；只轉 `content-type`、`accept`。
- `maxDuration = 300`。單一步驟的模型呼叫遠短於此。
- 依專案記一筆 log（專案 id、路徑、狀態碼、耗時），之後可據此加每專案用量上限（不在本次範圍）。

## 6. 錯誤處理

| 情境 | 處理 |
|---|---|
| 取不到 runtime 通行證（換新與登入都失敗） | chat 回 503「agent 環境暫時無法連線資料庫」，log 記專案 id |
| runtime 帳號不存在（尚未補建） | 轉送前自動建立後再取通行證 |
| 通行證在 run 中途過期 | 不會發生（取得時保證剩 ≥ 20 分鐘，run 最長 15 分鐘）；若仍發生，該次寫入失敗，run 標成失敗 |
| policy 擋下 runtime 需要的動作 | 視為 bug。上線前由權限測試逐項覆蓋 runtime 的每一個查詢 |
| 模型代理失敗 | 代理回 502；runtime 照現有的模型錯誤流程把 run 標成失敗 |

## 7. 測試

1. 權限（web，打雲端 Supabase，用真的通行證）：
   - runtime 帳號：讀得到自己專案的 `agent_instances`、`threads`、skill zip、project-files。讀不到別的專案的。讀不到 `usage_events`、`profiles`、`projects`、`instance_secrets`、`remote_mcp_targets`。
   - 訊息：改不了已結束 run 的 final；刪不了非空白的 final。
   - `get_project_secrets` 只取得到自己專案。
   - 一般使用者的通行證：讀不到 `agent_instances.system_prompt`、skill zip。
   - runtime 帳號呼叫網站 API → 401。
2. `runtimeAccessToken`：剩餘效期足夠時沿用；不足時換新並寫回；refresh 失效時改用密碼登入。
3. runtime 現有測試：改用 runtime 帳號的通行證跑（測試以 secret key 建立資料、以 runtime 帳號執行）；新增「沒有 db token 回 401」「開機不連資料庫」「run 開始時清理遺留 run」。
4. 模型代理：沒有或錯誤的專案通行證 → 401；串流原樣轉回；不轉送請求方的其他標頭。
5. 正式驗收：
   - `probe-sandbox.ts` 在暫時 Sprite 上確認 `.env` 不含任何金鑰。
   - smoke test。
   - 重新佈建後逐台確認健康。
   - 再以平台驗收腳本跑一次遠端 MCP 顧問。

## 8. 上線順序（對外動作先取得使用者同意）

| 階段 | 內容 |
|---|---|
| 1 | migration：`runtime_project()`、收回預設權限、grant 與 policy、Storage policy、`get_project_secrets` 檢查、`project_runtime_accounts`、`handle_new_user` 調整。網站用 secret key，不受影響，可先上（使用者在 Dashboard 執行） |
| 2 | web：建立／刪除 runtime 帳號、通行證取得與快取、`forwardChat` 帶 db token、`currentUser` 拒絕 runtime 帳號、模型代理。push `main` |
| 3 | 執行 `backfill-runtime-accounts.ts` 補建既有專案的帳號 |
| 4 | runtime：改用 db token、模型走代理、`.env` 不含金鑰。`publish-runtime` → `redeploy-runtime`，逐台確認 |
| 5 | 輪換 Supabase secret key 與 Vertex 金鑰。舊金鑰曾存在 Sprite 與開發電腦上。需要 Supabase API Keys 管理權限與 Vertex 所在的 Google Cloud 專案，與 Eric 一起做；換完更新 Vercel 與本機 `.env` |

階段 2 上線後、階段 4 之前，新舊 runtime 並存：舊 runtime 忽略 `x-agenthub-db-token`，照樣用 `.env` 的金鑰；新 runtime 不需要金鑰。所以可以先上 web，再逐步重新佈建。

## 9. 不在本次範圍

- 每專案的模型用量上限（代理已留下 log，之後可加）。
- 縮短 Supabase 全站的通行證效期。
- 平台代管 MCP（子專案 3b）。
