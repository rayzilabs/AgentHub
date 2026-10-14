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
| 遠端 MCP server | 創作者的腳本與資料，透過 MCP 提供工具；創作者自己架或平台代管（各自一台專用 Sprite） | agent 經平台閘道 `/api/mcp/<顧問id>/<MCP 名稱>` 呼叫 | 創作者自己的資料與金鑰；只接受平台簽發的創作者通行證（子專案 3） |
| 平台閘道（Vercel） | 驗證專案通行證、簽創作者通行證、轉送、記用量 | runtime | 簽章私鑰 `MCP_SIGNING_KEY`、`RUNTIME_TOKEN_SECRET` |

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
| 沙盒拿不到平台金鑰 | ✅ 2026-10-13 子專案 1-A 上線，所有既有 Sprite 已重新佈建並逐台驗證 |
| 平台金鑰外洩時，影響只限一個專案 | 📝 子專案 1-C |
| 顧問之間讀不到彼此的 skill 與工作目錄；主管只讀得到 `/shared`；每個帳號有私人 `/tmp` | ✅ 2026-10-14 子專案 2 上線，所有既有 Sprite 已重新佈建並逐台驗證 |
| 創作者的腳本與資料留在遠端 MCP；創作者 MCP 的網址與金鑰不進 Sprite；取消租用後立即無法呼叫 | ✅ 自己架（3a，2026-10-14）；平台代管待 3b |
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
| `remote_mcp_targets` | ❌ | ❌ | ❌ | ❌ | 創作者 MCP 的網址／代管版本；只有閘道（`service_role`）讀得到（子專案 3） |
| `mcp_usage` | ❌ | ❌ | ❌ | ❌ | 由閘道寫入；runtime 不碰（子專案 3） |
| Storage `skills` | 只能下載 | ❌ | ❌ | ❌ | 只限自己專案租用的顧問的 skill zip |
| Storage `project-files` | 列出、下載 | ❌ | ❌ | ❌ | 只限 `<自己專案 id>/` 資料夾；上傳由網頁處理 |
| Storage `runtime` | ❌ | ❌ | ❌ | ❌ | 安裝時由 Vercel 給一次性下載連結 |
| 模型（Vertex） | 透過 Vercel 代理呼叫 | | | | Sprite 不放 Vertex 金鑰；可設每專案用量上限 |

新增功能需要 runtime 多一項權限時：先改這張表，再改 migration。

## 5. Sprite 裡的帳號與檔案（子專案 1-A）

| 帳號 | 用途 | sudo |
|---|---|---|
| `sprite` | runtime | 有 |
| `agent` | 主管的 `read_file`；子專案 2 之前也代表所有顧問 | 沒有 |
| `agent-<顧問 id 去掉連字號後前 12 碼>` | 子專案 2 起：該顧問的 `bash`、`read_file`／`write_file`、stdio MCP；runtime 每次 run 時以 `agenthub-sandbox-adduser` 確保存在 | 沒有 |

```text
/home/sprite/agenthub/       700  sprite            runtime 專用：main.js、.env（600，只剩不敏感的設定）
/workspace/agents/           0711 sprite:workspace  只有 runtime 能建立項目
/workspace/agents/<顧問id>/  2770 sprite:agent-<id12>  只有 runtime 與該顧問：工作目錄
/workspace/skills/           0711 sprite:workspace  只有 runtime 能建立項目
/workspace/skills/<顧問id>/  2750 sprite:agent-<id12>  同步下來的 skills；該顧問只能讀（不能建立或改名項目）
/workspace/shared/           2770 sprite:workspace  所有顧問與主管共用的交接區
/var/lib/agenthub/tmp/<帳號>/ 700 該帳號            沙盒裡掛成 /tmp（每個帳號一份）
```

- 以 `agent` 執行時，環境變數清空，只留 `PATH`、`HOME`、`LANG`、`TZ`（加上 stdio MCP 自己的金鑰，經由環境變數而不是指令參數）。
- 執行路徑：`sudo unshare --mount` → 沙盒腳本 `/usr/local/bin/agenthub-sandbox` 在獨立的掛載命名空間裡用 `/dev/null` 蓋掉 `/.sprite/api.sock` → `setpriv` 降權成 `agent`。Sprite 內部 API 能建立以 runtime 帳號（有 sudo）執行的服務，而它在唯讀掛載上、改不了權限，所以只能在命名空間裡蓋掉。
- 「以哪個帳號執行」是參數：顧問用自己的帳號，主管用 `agent`。顧問目錄 `/workspace/agents/<id>` 是 `sprite:agent-<id12> 2770`，只有 runtime 與該顧問進得去；`/shared` 所有帳號共用（子專案 2，見 `docs/superpowers/specs/2026-10-13-consultant-isolation-design.md`）。
- 已知限制：顧問之間看得到彼此的程序清單（名稱與參數）；祕密一律不放在參數裡。

**驗收**：在真的 Sprite 上，以 agent 身分嘗試以下動作，全部都必須失敗：`env` 看到金鑰、`cat ~/agenthub/.env`、`read_file` 讀 `.env`、建立指向 `.env` 的 symlink 後讀取、讀 runtime 程序的 `/proc/<pid>/environ`、`sudo -n true`、存取 `/.sprite/api.sock`。另外 runtime 帳號要仍能使用 `/.sprite/api.sock`（保持喚醒），沙盒裡要找得到 node 與 python3。腳本：`apps/web/scripts/probe-sandbox.ts`（2026-10-13 12 項全部通過）。

## 6. 子專案進度

| # | 子專案 | 狀態 | 文件 |
|---|---|---|---|
| 1 | 平台金鑰隔離（A：分開帳號；C：只限自己專案的權限） | ✅ A 已上線（2026-10-13）；📝 C 待 Eric 確認 Supabase 簽章設定 | `docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md` |
| 2 | 顧問之間隔離 | ✅ 已上線（2026-10-14） | `docs/superpowers/specs/2026-10-13-consultant-isolation-design.md` |
| 3 | 遠端 MCP 的平台支援（閘道與通行證、自己架與平台代管、用量、版本、大量資料慣例） | ✅ 3a＋3c 已上線（2026-10-14）；3b 平台代管待做 | `docs/superpowers/specs/2026-10-14-remote-mcp-design.md` |
| 4 | 金融顧問改走遠端 MCP（`agenthub-fintech-agents`） | ⏳ | — |

## 7. 已知缺口與待辦

- 單一顧問模式的原始工具輸入輸出會送到瀏覽器（見第 3 節）。
- 2026-10-13 之前，agent 讀得到每台 Sprite `.env` 裡的平台金鑰且可 sudo 成 root；A 上線後已封住，但金鑰仍存在 `.env`（只有 runtime 讀得到），C 上線後才會移除。
- 子專案 1 上線前，平台金鑰已存在每台 Sprite 的 `.env`；全部重新佈建後應輪換 Supabase secret key 與 Vertex 金鑰。
