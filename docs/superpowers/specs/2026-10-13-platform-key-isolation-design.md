# 平台金鑰隔離（子專案 1）技術規格

- 日期：2026-10-13
- 狀態：設計已逐段確認，待最終審閱
- 目標：沙盒（agent 的工作區）拿不到平台金鑰；runtime 本身也只持有「只限自己專案、短期有效」的權限
- 長期參考：`docs/security-model.md`（權限表、帳號與檔案配置、誰看得到什麼都以那份為準，本文不重複）
- 範圍：A（同一台 Sprite 分開帳號）＋ C（runtime 改用專案範圍的短期通行證）。B（沙盒獨立成另一台 Sprite）不做

---

## 0. 現況與外洩路徑

2026-10-13 在使用者自己的測試專案 Sprite 上唯讀查證：runtime 以 `sprite`（uid 1001）執行、可免密碼 sudo；`~/agenthub/.env` 權限 `644`；沒有 yama ptrace 限制；有 `useradd`、`setpriv`、`runuser`、`unshare`。

| # | 外洩路徑 | 位置 |
|---|---|---|
| 1 | bash 繼承 runtime 的環境變數（含 `SUPABASE_SECRET_KEY`、`VERTEX_API_EXPRESS_MODE_KEY`） | `packages/runtime/src/tools/bash.ts` 的 `env: process.env` |
| 2 | `.env` 放在 agent 工作目錄上兩層，所有帳號可讀 | `apps/web/lib/sprites.ts` 的 `installRuntime` |
| 3 | `read_file` / `write_file` 在 runtime 程序內執行，可讀任意絕對路徑，也會跟著 symlink 走 | `packages/runtime/src/tools/files.ts` |
| 4 | stdio MCP 以 runtime 同一個帳號執行（環境變數只帶 HOME、PATH 等與它自己的金鑰），可讀 `.env` 與 runtime 的 `/proc/<pid>/environ` | `packages/runtime/src/mcp.ts` |
| 5 | agent 與 runtime 同一個 uid，可讀 `/proc/<runtime pid>/environ` | — |
| 6 | agent 可 `sudo` 成 root | Sprite 預設 sudoers |
| 7 | 平台金鑰權限是整個資料庫的最高權限（含 Auth 管理、Vault 解密、Storage 全部 bucket） | — |
| 8 | Sprite 內部 API `/.sprite/api.sock`（`root:root 666`）任何帳號都能用，可建立以 runtime 帳號（有 sudo）執行的服務；它是唯讀 overlay 上的綁定掛載，改不了權限（2026-10-13 實測） | Sprite 平台 |

A 處理 1–6、8；C 處理 7。

## 1. 決策紀錄

| 項目 | 決定 |
|---|---|
| 隔離方式 | 同一台 Sprite、不同 Linux 帳號（A）；不拆成兩台 Sprite（B） |
| agent 帳號 | 新增 `agent`，沒有 sudo；「以哪個帳號執行」做成參數，子專案 2 會改成每位顧問一個帳號 |
| 以 agent 執行的範圍 | `bash`、`read_file`、`write_file`、stdio MCP |
| 環境變數 | 以 agent 執行時清空，只留 `PATH`、`HOME`、`LANG`（stdio MCP 另外加上它自己需要的金鑰） |
| 工作區位置 | 從 `~/agenthub/{agents,shared}` 搬到 `/workspace/{agents,shared}`；`sprite` 與 `agent` 同屬 `workspace` 群組 |
| runtime 的資料庫權限 | Vercel 每次轉送對話時簽發一張只限該專案、約 20 分鐘過期的通行證；資料庫以自訂角色＋RLS 強制執行權限表 |
| 模型呼叫 | 改由 Vercel 代理呼叫 Vertex；Sprite 不放 Vertex 金鑰 |
| `.env` 內容 | 只剩 `PROJECT_ID`、路徑等不敏感設定 |
| 時程 | A 在 2026-10-23 展覽前上線；C 視驗證結果，目標展覽前，最晚展覽後第一週 |

## 2. A：同一台 Sprite 分開帳號

### 2.1 佈建（`apps/web/lib/sprites.ts` 的 `installRuntime`）

以 `sprite` 帳號用 sudo 執行一段可重複執行的設定腳本：

1. `agent` 帳號不存在就建立（`useradd --create-home --shell /bin/bash agent`），不加入 sudo 群組。
2. `workspace` 群組不存在就建立，把 `sprite`、`agent` 加進去。
3. 建立 `/workspace/agents`、`/workspace/shared`，擁有者 `agent:workspace`，權限 `2770`（setgid，新檔案沿用 `workspace` 群組）。
4. 舊的 `~/agenthub/agents`、`~/agenthub/shared` 若存在，搬到 `/workspace` 並修正擁有者與權限（已存在的專案重新佈建時不遺失顧問寫出的檔案）。
5. `~/agenthub` 設為 `700`、`.env` 設為 `600`。
6. 安裝沙盒腳本 `/usr/local/bin/agenthub-sandbox`（`root:root 755`，見 2.2）。

`.env` 的 `AGENTS_ROOT`、`SHARED_ROOT` 改成 `/workspace/agents`、`/workspace/shared`。runtime 程序本身的 umask 設為 `002`，讓它寫進工作區的檔案 `agent` 也能讀寫。

### 2.2 以指定帳號執行（`packages/runtime/src/sandbox.ts`，新增）

```ts
export type SandboxUser = string; // 目前一律 'agent'；子專案 2 改成每位顧問一個帳號

/** 以指定帳號執行；環境變數只保留白名單與 extraEnv */
export function sandboxSpawn(user: SandboxUser, argv: string[], opts: { cwd: string; extraEnv?: Record<string, string> }): ChildProcess;

/** 以指定帳號終止整個程序群組（sprite 不能直接對 agent 的程序送訊號） */
export function sandboxKill(user: SandboxUser, pgid: number): Promise<void>;
```

- 實作：`sudo -n -E -- unshare --mount --propagation private -- /usr/local/bin/agenthub-sandbox <user> <argv...>`。沙盒腳本以 root 在這個獨立的掛載命名空間裡用 `/dev/null` 蓋掉 `/.sprite/api.sock`（蓋不掉就失敗），再 `setpriv --reuid/--regid/--init-groups --inh-caps=-all` 降權成 `<user>`，`umask 002`，`PATH` 從 `SANDBOX_PATH` 還原（sudo 會把 PATH 重設成系統預設，`/.sprite/languages` 底下的 node、python 會找不到）。
- 環境變數由 spawn 時給的白名單決定，`sudo -E` 原樣帶過去；祕密不放進指令參數（`/proc/<pid>/cmdline` 所有帳號都讀得到）。
- 逾時或中止時，用 `sudo -n -u <user> -- kill -KILL -- -<pgid>` 終止整個程序群組。`runBash` 現有的「孫行程佔住 stdout」處理保留。

### 2.3 工具改用 `sandboxSpawn`

| 工具 | 做法 |
|---|---|
| `bash` | `runBash` 改成透過 `sandboxSpawn(user, ['bash', '-c', command])`；介面、逾時、截斷都不變 |
| `read_file` | 以 agent 執行 `cat -- <path>`；檔案不存在或沒有權限時回傳錯誤字串（與現在相同的 `{ error }` 形狀）；仍截斷到 20,000 字 |
| `write_file` | 以 agent 執行 `mkdir -p` 與寫入，內容從 stdin 傳入，不放進指令參數 |
| stdio MCP | `connectMcpServers` 把 `command`／`args` 包成 `sandboxSpawn` 的形式，只帶該 MCP 的 `required_secrets` |
| 主管的 `read_file` | 同樣以 agent 執行（子專案 2 再改成只能讀 `/shared` 的帳號） |

工具的輸入輸出形狀不變，prompt 不用改。runtime 自己的檔案操作（同步 skills、同步專案檔案）仍在 runtime 程序內執行。

### 2.4 本機開發與測試

本機沒有 `agent` 帳號也沒有 sudo。`sandboxSpawn` 依設定 `SANDBOX_USER` 決定：未設定時直接以目前帳號執行（環境變數仍然清空，只留白名單）。Sprite 上一律設定為 `agent`。單元測試涵蓋「環境變數被清空」；帳號隔離本身在真的 Sprite 上驗收（見 5.）。

## 3. C：runtime 只限自己專案的權限

### 3.1 通行證

- 由 Vercel 簽發 JWT：`role = 'agenthub_runtime'`、`project_id = <專案 id>`、`exp = 現在 + 20 分鐘`。
- 簽發時機：`forwardChat` 轉送對話時放在請求標頭 `x-agenthub-token`；runtime 用它建立這次 run 的 Supabase client（`createDb(url, token)`），run 結束即丟棄。
- runtime 不再有長期的資料庫憑證；目前在啟動時用金鑰做的 `failRunningRuns` 移到 Vercel：轉送對話前，把該專案超過 20 分鐘仍在 running 的 run 標成失敗（web 讀取時本來就這樣判斷）。
- runtime 的 `/health` 與 Sprite 的 URL 驗證（`auth: 'sprite'`）不變。

### 3.2 資料庫

- 新增角色 `agenthub_runtime`（`nologin`），`grant agenthub_runtime to authenticator`，讓 PostgREST 依 JWT 的 `role` 切換。
- 依 `docs/security-model.md` 第 4 節的權限表，對每張表 `grant` 最小的動作與欄位（欄位層級 `grant update (status, error, finished_at) on runs` 等），再加上 RLS policy，條件一律以 `(auth.jwt() ->> 'project_id')::uuid` 判斷所屬專案。
- `messages` 的修改與刪除另加條件：所屬 run 的 `status = 'running'`；刪除再加 `kind = 'final' and content = ''`。
- `get_project_secrets(p_project_id)`：`grant execute ... to agenthub_runtime`；函式內第一行檢查 `p_project_id = (auth.jwt() ->> 'project_id')::uuid`，不符就丟錯。`service_role` 照舊可用。
- Storage：`storage.objects` 的 select policy——`project-files` 限 `name like '<project_id>/%'`；`skills` 限「名稱等於自己專案某個 agent_instance 的 `skills_zip_path`」。
- 現有表都已開 RLS 且沒有 policy，`service_role`（Vercel）不受影響。

### 3.3 模型代理

- 新增 Vercel 路由 `POST /api/runtime/model/...`：驗證 `x-agenthub-token`（同一張通行證）後，把請求原樣轉給 Vertex express 端點並串流回傳；Vertex 金鑰只在 Vercel。
- runtime 的 `createVertex` 改成 `baseURL` 指向這個路由、標頭帶通行證。
- 每次呼叫寫一筆伺服器端紀錄（專案 id、模型、時間），之後可做每專案用量上限；本子專案不實作上限。
- 每次模型呼叫遠短於 Vercel Hobby 的 300 秒上限；長討論的總時間不受影響（每一步是一次獨立的呼叫）。

### 3.4 佈建

- `.env` 不再寫入 `SUPABASE_SECRET_KEY`、`VERTEX_API_EXPRESS_MODE_KEY`。
- runtime 安裝檔照舊由 Vercel 產生一次性下載連結（現在已是如此）。

## 4. 錯誤處理

| 情境 | 處理 |
|---|---|
| 通行證過期（run 超過 20 分鐘） | run 上限是 15 分鐘，通行證效期留有餘裕；過期時資料庫拒絕寫入，run 標成失敗（由 Vercel 下次清理） |
| 通行證缺少或無效 | runtime 回 401，Vercel 顯示「agent 環境驗證失敗」 |
| 權限不足（權限表漏列） | 資料庫回權限錯誤；錯誤訊息寫進 run 的 error，方便補表 |
| `sudo` 失敗（佈建不完整） | 工具回傳錯誤字串給模型，同時寫 log；`/health` 加上「沙盒帳號可用」檢查，佈建時就能發現 |
| 舊 Sprite 尚未重新佈建 | `SANDBOX_USER` 有設定、但該帳號不存在或 sudo 失敗時，runtime 拒絕啟動並回報，避免在沒有隔離的狀態下以為已隔離；未設定 `SANDBOX_USER`（本機開發）不檢查 |

## 5. 測試

1. **單元測試（Vitest）**
   - `sandboxSpawn`：環境變數只剩白名單與 `extraEnv`；逾時會終止整個程序群組（本機模式）。
   - 工具形狀不變：`bash`、`read_file`、`write_file` 的既有測試照常通過。
   - 通行證簽發：欄位、效期；runtime 拒絕沒有通行證的請求。
2. **資料庫（pgTAP）**：權限表每一列至少一個「允許」與一個「拒絕」的測試，含跨專案存取、修改已結束的訊息、讀 `usage_events`、呼叫別專案的 `get_project_secrets`、讀別專案的 Storage 物件。
3. **真實 Sprite 驗收**（手動，新開專案）：以 agent 身分嘗試 `env`、`cat ~/agenthub/.env`、`read_file` 讀 `.env`、symlink 指向 `.env` 後讀、讀 `/proc/<runtime pid>/environ`、`sudo -n true`、存取 `/.sprite/api.sock`——全部必須失敗；再跑一次派工、討論、上傳檔案、記憶，確認功能正常。

## 6. 實作前要先驗證

1. **Supabase 能否自行簽發 JWT**：專案用新制 API 金鑰（`sb_secret_…`）。要確認能匯入自己的簽章私鑰，或仍可使用舊制 JWT secret。若都不行，改用替代做法：runtime 不直接連資料庫，改呼叫 Vercel 的專用 API（每個動作一個端點，依同一張權限表檢查），權限表不變。
2. **`/.sprite/api.sock` 的權限**：✅ 已驗證（2026-10-13）。agent 碰得到，且能建立服務；socket 在唯讀掛載上改不了權限 → 改用掛載命名空間蓋掉（見 2.2）。暫時 Sprite 實測：agent 連線失敗、無法 umount、runtime 帳號照常可用、掛載來源 `/tmp/sprite.sock` 不可見、`/proc/1/root` 拒絕存取。
3. **Sprite 的 service 是否會被 `useradd` 等系統變更影響**：✅ 已驗證（2026-10-13）。重新佈建後 runtime 服務正常啟動（含沙盒帳號啟動檢查）。驗收腳本 `apps/web/scripts/probe-sandbox.ts` 12 項全部通過。

## 7. 部署

| 順序 | 內容 | 方式 |
|---|---|---|
| 1 | migration（角色、grant、RLS、Storage policy、`get_project_secrets` 檢查） | `pnpm db:push`、`pnpm db:test`；對 `service_role` 沒有影響，可先上 |
| 2 | web（通行證簽發、模型代理、`installRuntime` 新佈建流程、轉送前清理） | push `main` |
| 3 | runtime | `publish-runtime` |
| 4 | 既有 Sprite | `redeploy-runtime`（會重啟所有 Sprite，含展覽 Demo）；執行前與使用者、Eric 確認時間 |
| 5 | 輪換金鑰 | 全部重新佈建完成後，輪換 Supabase secret key 與 Vertex 金鑰（舊金鑰已存在每台 Sprite 的 `.env`） |

A 與 C 可以分開上線：A 只需要 2、3、4；C 再加上 1 與第二輪的 2、3、4。

## 8. 不在本次範圍

- 顧問之間隔離（子專案 2）。
- 遠端 MCP 的代管、計費、版本（子專案 3）。
- 每專案的模型用量上限（3.3 只留紀錄）。
- 沙盒的對外網路限制（agent 仍可連外網）。
- 單一顧問模式下原始工具輸入輸出送到瀏覽器的缺口。
