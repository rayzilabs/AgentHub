# AgentHub 安全模型

這份是長期維護的文件：誰能碰到什麼、權限怎麼切。權限有任何變動都要更新這份。
各子專案的實作細節在 `docs/superpowers/specs/`，這裡只記結論。

- 最後更新：2026-10-13
- 狀態欄位：✅ 已上線、🚧 實作中、📝 已設計、⏳ 尚未設計

---

## 1. 要保護什麼

| 資產 | 擁有者 | 外洩的後果 |
|---|---|---|
| 平台金鑰（Supabase secret key、Vertex 金鑰） | 平台 | 可讀寫整個資料庫：所有人的對話與檔案、創作者的 prompt 與 skill、租用者的 MCP 金鑰；可刪帳號、竄改 runtime |
| 創作者的 system prompt、SKILL.md、腳本、資料 | 創作者 | 創作者變現的核心資產被抄走 |
| 租用者的對話、上傳檔案、記憶、MCP 金鑰 | 租用者 | 隱私與第三方帳號外洩 |
| 用量帳本（`usage_events`） | 平台與創作者 | 計費被竄改 |

**基本假設**：agent 執行什麼指令是模型決定的，而租用者可以誘導模型（直接要求或藏在上傳檔案裡）。所以**沙盒裡的一切都當作租用者看得到**，沙盒的權限就等於租用者的權限。

## 2. 元件與角色

| 元件 | 是什麼 | 給誰用 | 持有的權限 |
|---|---|---|---|
| Vercel（`apps/web`） | 網頁與 `/api/*` | 使用者的瀏覽器 | 平台金鑰（只在伺服器端） |
| runtime（`packages/runtime`） | 每個專案一台 Sprite 上的平台程式：組 agent、呼叫模型、執行工具、寫回進度 | 平台本身，使用者不會直接碰到 | 目標：只限自己專案的短期通行證（見第 4 節） |
| 沙盒 | 同一台 Sprite 上，agent 執行 bash、讀寫檔案的工作區 | agent（間接：創作者的腳本在這裡跑、租用者的檔案放這裡） | 目標：沒有任何平台金鑰 |
| 遠端 MCP server | 創作者自己的腳本與資料，透過 http 提供工具 | 創作者提供、agent 呼叫 | 創作者自己的資料；連線金鑰由租用者提供 |

## 3. 誰看得到什麼

| | 顧問 A 的 skill／腳本 | 顧問 A 的工作目錄 | 顧問 A 交回的結果 | `/shared` | 平台金鑰 | 遠端 MCP 的腳本與原始資料 |
|---|---|---|---|---|---|---|
| 顧問 A | ✅ | ✅ | ✅ | ✅ | ❌ | ❌（只拿到工具回傳的結果） |
| 顧問 B | ❌ | ❌ | ✅（主管轉述、討論紀錄） | ✅ | ❌ | ❌ |
| 主管 | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ |
| 租用者 | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ |
| runtime | ✅ | ✅ | ✅ | ✅ | 只有自己專案的通行證 | ❌ |

| 規則 | 狀態 |
|---|---|
| 沙盒拿不到平台金鑰 | 📝 子專案 1-A |
| 平台金鑰外洩時，影響只限一個專案 | 📝 子專案 1-C |
| 顧問之間讀不到彼此的 skill 與工作目錄；主管只讀得到 `/shared` | ⏳ 子專案 2 |
| 創作者的腳本與資料留在遠端 MCP | ⏳ 子專案 3 |
| 瀏覽器只收到工具摘要（動作、描述、時間），不收原始指令與輸出（派工卡片、討論發言） | ✅ 2026-10-13 |
| 單一顧問模式下，主管／顧問本身的原始工具輸入輸出仍會隨串流送到瀏覽器 | ⏳ 已知缺口 |

## 4. runtime 的資料庫權限（子專案 1-C）

runtime 不再持有平台金鑰。Vercel 每次轉送對話時，附上一張**只對該專案有效、約 20 分鐘過期**的通行證；權限由資料庫的自訂角色與列級權限（RLS）強制執行，不靠 runtime 的程式自律。

「自己專案」指通行證上寫的專案。

| 資料 | 讀 | 新增 | 修改 | 刪除 | 限制 |
|---|---|---|---|---|---|
| `auth.users`、`profiles`、`projects` | ❌ | ❌ | ❌ | ❌ | runtime 用不到 |
| `agent_templates` | 只能讀 `creator_id` | ❌ | ❌ | ❌ | 只限自己專案租用的範本 |
| `agent_instances` | ✅ | ❌ | ❌ | ❌ | 自己專案 |
| `instance_secrets`／Vault | 只能透過 `get_project_secrets` | ❌ | ❌ | ❌ | 函式本身檢查只能取自己專案 |
| `threads` | ✅ | ❌ | ❌ | ❌ | 自己專案 |
| `runs` | ✅ | ✅ | 只能改 `status`、`error`、`finished_at` | ❌ | 自己專案的對話 |
| `messages` | 只能讀 `kind`、`content` | ✅ | 只能改還在執行中的 run 的 `final` 的 `content`、`ui_message`、`tool_events`、`updated_at` | 只能刪還在執行中的 run 的空白 `final` | 已結束的歷史訊息不能改、不能刪 |
| `memories` | ✅ | ✅ | ❌ | ❌ | 自己專案；修改與刪除由使用者在網頁上操作 |
| `usage_events` | ❌ | ✅ | ❌ | ❌ | 只能新增；計費帳本不能被竄改或偷看 |
| Storage `skills` | 只能下載 | ❌ | ❌ | ❌ | 只限自己專案租用的顧問的 skill zip |
| Storage `project-files` | 列出、下載 | ❌ | ❌ | ❌ | 只限 `<自己專案 id>/` 資料夾；上傳由網頁處理 |
| Storage `runtime` | ❌ | ❌ | ❌ | ❌ | 安裝時由 Vercel 給一次性下載連結 |
| 模型（Vertex） | 透過 Vercel 代理呼叫 | | | | Sprite 不放 Vertex 金鑰；可設每專案用量上限 |

新增功能需要 runtime 多一項權限時：先改這張表，再改 migration。

## 5. Sprite 裡的帳號與檔案（子專案 1-A）

| 帳號 | 用途 | sudo |
|---|---|---|
| `sprite` | runtime | 有 |
| `agent` | 代表 agent 執行的一切：`bash`、`read_file`／`write_file`、stdio MCP | 沒有 |

```text
/home/sprite/agenthub/       700  sprite            runtime 專用：main.js、.env（600，只剩不敏感的設定）
/workspace/agents/<顧問id>/        sprite+agent 群組  工作目錄與同步下來的 skills
/workspace/shared/                 sprite+agent 群組  專案共用檔案
```

- 以 `agent` 執行時，環境變數清空，只留 `PATH`、`HOME`、`LANG`。
- 「以哪個帳號執行」是參數。子專案 2 會改成每位顧問一個帳號（`agent-<顧問 id 前 8 碼>`），主管用只能讀 `/shared` 的帳號。

**驗收**：在真的 Sprite 上，以 agent 身分嘗試以下動作，全部都必須失敗：`env` 看到金鑰、`cat ~/agenthub/.env`、`read_file` 讀 `.env`、建立指向 `.env` 的 symlink 後讀取、讀 runtime 程序的 `/proc/<pid>/environ`、`sudo -n true`、存取 `/.sprite/api.sock`。

## 6. 子專案進度

| # | 子專案 | 狀態 | 文件 |
|---|---|---|---|
| 1 | 平台金鑰隔離（A：分開帳號；C：只限自己專案的權限） | 📝 已設計 | `docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md` |
| 2 | 顧問之間隔離 | ⏳ | — |
| 3 | 遠端 MCP 的平台支援（代管、每位租用者的金鑰、用量計費、版本、大量資料下載） | ⏳ | — |
| 4 | 金融顧問改走遠端 MCP（`agenthub-fintech-agents`） | ⏳ | — |

## 7. 已知缺口與待辦

- 單一顧問模式的原始工具輸入輸出會送到瀏覽器（見第 3 節）。
- 子專案 1 上線前，所有 Sprite 的 `.env` 都存有平台金鑰，且 agent 可 sudo 成 root。舊專案要重新佈建（`redeploy-runtime`）才會套用新設定。
- 子專案 1 上線前，平台金鑰已存在每台 Sprite 的 `.env`；全部重新佈建後應輪換 Supabase secret key 與 Vertex 金鑰。
