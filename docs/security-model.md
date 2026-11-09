# AgentHub 安全模型

這份是長期維護的文件：誰能碰到什麼、權限怎麼切。權限有任何變動都要更新這份。
各子專案的實作細節在 `docs/superpowers/specs/`，這裡只記結論。

- 最後更新：2026-11-09
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
| 租用者 | ❌ | ❌ | ✅ | 雲端資料夾裡的檔案（自己上傳的與顧問交付的）；顧問直接寫進 `/shared` 但沒交付的看不到 | ❌ | ❌ |
| runtime | ✅ | ✅ | ✅ | ✅ | 只有自己專案的通行證 | ❌ |

| 規則 | 狀態 |
|---|---|
| 沙盒拿不到平台金鑰 | ✅ 2026-10-13 子專案 1-A 上線，所有既有 Sprite 已重新佈建並逐台驗證 |
| 平台金鑰外洩時，影響只限一個專案 | ✅ 1-C（2026-10-14）：Sprite 上已無平台金鑰；舊金鑰曾存在 Sprite 與開發電腦上，待輪換 |
| 顧問之間讀不到彼此的 skill 與工作目錄；主管只讀得到 `/shared`；每個帳號有私人 `/tmp` | ✅ 2026-10-14 子專案 2 上線，所有既有 Sprite 已重新佈建並逐台驗證 |
| 創作者的腳本與資料留在遠端 MCP；創作者 MCP 的網址與金鑰不進 Sprite；取消租用後立即無法呼叫 | ✅ 自己架（3a，2026-10-14）；平台代管（3b，2026-10-15）：代管 Sprite 上只有該 MCP 的程式與創作者金鑰 |
| 瀏覽器只收到工具摘要（動作、描述、時間），不收原始指令與輸出（派工卡片、討論發言） | ✅ 2026-10-13 |
| 單一顧問模式下，主管／顧問本身的原始工具輸入輸出仍會隨串流送到瀏覽器 | ⏳ 已知缺口 |
| 雲端資料夾（2026-11-03）：使用者只看得到自己專案的檔案；顧問只能用 `deliver_file` 交付到自己專案、自己的資料夾底下，交付前以該顧問的沙盒帳號讀檔（讀不到就交不出去）；runtime 不能刪改使用者的檔案 | 🚧 2026-11-04 實作完成，待上線 |
| 組織（2026-11-09）：組織顧問只有成員租得到；成員離開或下架後，runtime 讀不到這位顧問、MCP 閘道拒絕 | 🚧 2026-11-09 資料庫部分實作中（`20261109000001_organizations.sql`） |

## 4. runtime 的資料庫權限（子專案 1-C）

runtime 不再持有平台金鑰。每個專案在 Supabase Auth 有一個系統帳號（`app_metadata.agenthub_runtime_project` = 專案 id）；Vercel 每次轉送對話時替它取得通行證（Supabase 簽發，效期依 Supabase 設定，目前 1 小時，轉送時保證至少剩 20 分鐘），放在 `x-agenthub-db-token` 交給 runtime。權限由欄位層級 grant 與列級權限（RLS，條件 `runtime_project()`）強制執行，不靠 runtime 的程式自律；一般使用者（含專案擁有者）與匿名者在所有表上都沒有權限。實作：`supabase/migrations/20261014000002_runtime_scoped_access.sql`，驗證：`supabase/tests/runtime_access.sql`。

「自己專案」指通行證上寫的專案。

| 資料 | 讀 | 新增 | 修改 | 刪除 | 限制 |
|---|---|---|---|---|---|
| `auth.users`、`profiles`、`projects` | ❌ | ❌ | ❌ | ❌ | runtime 用不到 |
| `agent_templates` | 只能讀 `creator_id` | ❌ | ❌ | ❌ | 只限自己專案租用的範本；policy 查的是 `agent_instances`，被擋的組織顧問的範本跟著濾掉 |
| `agent_instances` | ✅ | ❌ | ❌ | ❌ | 自己專案，且組織顧問（`org_id` 不是 null）要通過 `org_instance_problem`（專案擁有者仍是該組織成員、範本仍上架），否則讀不到 |
| `instance_secrets`／Vault | 只能透過 `get_project_secrets` | ❌ | ❌ | ❌ | 函式本身檢查只能取自己專案 |
| `threads` | ✅ | ❌ | ❌ | ❌ | 自己專案 |
| `runs` | ✅ | ✅ | 只能改 `status`、`error`、`finished_at` | ❌ | 自己專案的對話 |
| `queued_messages` | ✅ | ❌ | ❌ | ✅ | 自己專案的對話。新增與編輯由網站處理，runtime 只能取走（`delete ... returning`）；一列只會被一方取走 |
| `messages` | 只能讀 `id`、`thread_id`、`run_id`、`speaker_instance_id`、`kind`、`content`、`created_at` | ✅ | 只能改還在執行中的 run 的 `final` 的 `content`、`ui_message`、`tool_events`、`updated_at` | 只能刪還在執行中的 run 的空白 `final` | 已結束的歷史訊息不能改、不能刪 |
| `memories` | ✅ | ✅ | 只能改 `content`、`description`、`type`（`updated_at` 由資料庫觸發器維護） | ✅ | 自己專案。顧問之間的私有記憶隔離由 runtime 的程式負責（同一專案的顧問共用一個 runtime 帳號）；使用者也能在網頁上修改與刪除 |
| `usage_events` | ❌ | ✅ | ❌ | ❌ | 只能新增；計費帳本不能被竄改或偷看 |
| `remote_mcp_targets` | ❌ | ❌ | ❌ | ❌ | 創作者 MCP 的網址／代管版本；只有閘道（`service_role`）讀得到（子專案 3） |
| `mcp_usage` | ❌ | ❌ | ❌ | ❌ | 由閘道寫入；runtime 不碰（子專案 3） |
| `hosted_mcp_versions` | ❌ | ❌ | ❌ | ❌ | 平台代管 MCP 的版本、Sprite 名稱與網址；只有 Vercel（`service_role`）讀寫（3b） |
| `hosted_mcp_secrets`／Vault | ❌ | ❌ | ❌ | ❌ | 創作者給代管 MCP 的金鑰；只透過 `set_hosted_mcp_secret`／`get_hosted_mcp_secrets`，只有 `service_role` 能執行（3b） |
| `project_runtime_accounts` | ❌ | ❌ | ❌ | ❌ | runtime 帳號的密碼與通行證快取；只有 Vercel（`service_role`）讀得到 |
| `organizations` | ❌ | ❌ | ❌ | ❌ | 組織；只有 Vercel（`service_role`）讀寫 |
| `org_members` | ❌ | ❌ | ❌ | ❌ | 組織成員與角色；只有 Vercel（`service_role`）讀寫 |
| `org_invitations` | ❌ | ❌ | ❌ | ❌ | 組織邀請；只有 Vercel（`service_role`）讀寫 |
| `org_instance_problem` | | | | | `security definer`，回答一位顧問現在能不能呼叫（null／`not_member`／`unpublished`）；給 `agent_instances` 的 policy 用，所以 `authenticated` 能執行（取捨見第 7 節） |
| `project_instance_problems` | | | | | 列出專案裡被擋的組織顧問與原因，給專案畫面用；只有 `service_role` 能執行 |
| Storage `skills` | 只能下載 | ❌ | ❌ | ❌ | 只限自己專案租用的顧問的 skill zip；policy 查的是 `agent_instances`，被擋的組織顧問的 zip 跟著下載不到（例外：同一張通行證之前下載過的會從快取拿到，見第 7 節） |
| `project_folders` | 只能讀 `id`、`project_id`、`parent_id`、`name`、`created_at` | ❌ | ❌ | ❌ | 自己專案；雲端資料夾的資料夾（2026-11-03） |
| `project_files` | 只能讀 `id`、`project_id`、`folder_id`、`name`、`size`、`content_type`、`source`、`agent_instance_id`、`run_id`、`created_at`、`updated_at` | 只能透過 `deliver_project_file` | ❌ | ❌ | 自己專案；同步到 `/shared` 用。改名、搬移、刪除只有網頁（`service_role`）做得到 |
| `deliver_project_file` | | | | | runtime 交付檔案的唯一途徑（`security definer`）：函式本身檢查通行證的專案、顧問屬於這個專案、run 屬於這個專案、storage 物件是這個 runtime 帳號自己上傳的（`owner_id`），只能登記到該顧問的資料夾（以顧問名稱命名，被改名或刪掉就重建）底下；檔名、資料夾名不合法就拒絕 |
| `ensure_folder`、`register_project_file` | | | | | 只有 `service_role` 能執行（網頁上傳、舊檔搬移） |
| Storage `project-files` | 列出、下載、簽 1 小時網址 | 只能新增到 `<自己專案 id>/files/` 底下 | ❌ | ❌ | 只限 `<自己專案 id>/` 資料夾；使用者上傳由網頁處理。新增是給交付用的（`runtime_insert_project_files`），不能覆蓋或刪除；bucket 單檔上限 50 MB，runtime 另限單檔 50 MB、每次 run 合計 200 MB。簽名網址只給 `read_file` 確認過與上傳版本逐位元組相同的圖片，只送往 Vertex（模型依網址自己下載），不給顧問、不寫進資料庫（2026-10-30） |
| Storage `runtime` | ❌ | ❌ | ❌ | ❌ | 安裝時由 Vercel 給一次性下載連結 |
| Storage `mcp-bundles` | ❌ | ❌ | ❌ | ❌ | 創作者上傳的代管 MCP 套件；部署時由 Vercel 給代管 Sprite 一次性下載連結（3b） |
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
/workspace/agents/<顧問id>/.agenthub-venv/  2775 agent-<id12>:agent-<id12>  依 skill 的 requirements.txt 建的 Python 環境（顧問自己建、自己能改）
/workspace/skills/           0711 sprite:workspace  只有 runtime 能建立項目
/workspace/skills/<顧問id>/  2750 sprite:agent-<id12>  同步下來的 skills；該顧問只能讀（不能建立或改名項目）
/workspace/shared/           2770 sprite:workspace  所有顧問與主管共用的交接區；雲端資料夾整棵同步到這裡
/var/lib/agenthub/tmp/<帳號>/ 700 該帳號            沙盒裡掛成 /tmp（每個帳號一份）
/home/sprite/agenthub/shared-sync.json  sprite      雲端資料夾的同步紀錄（設定 SYNC_STATE_PATH），顧問改不到
```

- 雲端資料夾（2026-11-03）：storage 物件在 `project-files/<專案>/files/<檔案 id>`，資料夾與檔名記在 `project_folders`、`project_files`，改名、搬移只改資料表。預設資料夾「我上傳的」，每位顧問交付到以自己名稱命名的資料夾。每次 run 前 runtime 依資料表把整棵樹同步到 `/workspace/shared`（例：`/workspace/shared/ETF 資金流顧問/2026-W43/週報.docx`），只刪以前同步下來的檔案，顧問直接寫進 `/shared` 的不受影響。`/shared` 所有顧問都能寫，顧問可以把資料夾換成 symlink，所以 `/shared` 裡的建立、寫入、刪除一律以 `SANDBOX_USER`（`agent`）執行，runtime 自己只做 `lstat` 這類唯讀檢查；寫入前把被換成 symlink 或不是資料夾的上層刪掉重建，上層被換成 symlink 時不刪檔。同步紀錄不放在 `/shared`。名稱超過 255 bytes 的略過，單一檔案下載或寫入失敗只略過那一個。
- 顧問交付（2026-11-03）：`deliver_file` 以該顧問自己的沙盒帳號讀檔（`stat -L` 檢查大小、`head -c` 限制讀取量、`pipefail`），symlink 指向它讀不到的檔案就交不出去；檔名與資料夾名在上傳前先檢查（runtime 刪不掉已上傳的物件），上傳後呼叫 `deliver_project_file` 登記。主管沒有這個工具。

- 以 `agent` 執行時，環境變數清空，只留 `PATH`、`HOME`、`LANG`、`TZ`（加上 stdio MCP 自己的金鑰，經由環境變數而不是指令參數）。
- 執行路徑：`sudo unshare --mount` → 沙盒腳本 `/usr/local/bin/agenthub-sandbox` 在獨立的掛載命名空間裡用 `/dev/null` 蓋掉 `/.sprite/api.sock` → `setpriv` 降權成 `agent`。Sprite 內部 API 能建立以 runtime 帳號（有 sudo）執行的服務，而它在唯讀掛載上、改不了權限，所以只能在命名空間裡蓋掉。
- 「以哪個帳號執行」是參數：顧問用自己的帳號，主管用 `agent`。顧問目錄 `/workspace/agents/<id>` 是 `sprite:agent-<id12> 2770`，只有 runtime 與該顧問進得去；`/shared` 所有帳號共用（子專案 2，見 `docs/superpowers/specs/2026-10-13-consultant-isolation-design.md`）。
- 已知限制：顧問之間看得到彼此的程序清單（名稱與參數）；祕密一律不放在參數裡。
- 語言工具（2026-10-30）：`/.sprite/bin` 的包裝腳本（python3、node、go、java、ruby…，共 40 多個）第一次執行時，要把各自的 `export` 行寫進 `sprite` 帳號的 `/etc/profile.d/languages_env`，沙盒帳號沒有寫入權限，寫不進去就失敗；10/13 改用沙盒帳號後，新建的 Sprite 除了 Node 之外全部會撞到。佈建時由 runtime 帳號從包裝腳本讀出這些行、補齊缺的（不執行語言工具），並以 root 把 numpy、pandas 裝進 pyenv 的 Python。包裝腳本也會把自己的路徑寫進 `/etc/profile.d/languages_paths`，寫不進去只印 `Permission denied`（2026-10-31 發現會混進顧問的輸出），佈建時一併以 `languages_env` 展開後補齊。`probe-sandbox.ts` 以沙盒帳號逐一檢查常用工具。
- 顧問的 Python 套件（2026-10-30）：創作者在 skill 資料夾放 `requirements.txt`。上架時平台只接受 PyPI 上的具名套件（不接受選項、網址、`@`、本機路徑、環境標記），並向 PyPI 確認套件與版本存在。runtime 每次 run 以**該顧問的沙盒帳號**在工作目錄建 `.agenthub-venv`（`--system-site-packages`，看得到預裝的 numpy、pandas）並以 pip 安裝，所以套件的安裝腳本只有顧問自己的權限。各顧問同時安裝。以內容雜湊決定是否重裝，失敗的同一份一小時內不重試；pip 以 `timeout` 限制 180 秒（逾時會被終止）；同一位顧問同時兩個對話共用一次安裝。狀態檔（`.requirements-sha256`、`.requirements-failed`）在顧問可寫的目錄、由 runtime 帳號讀，是 symlink 就不採信。只讀有 `SKILL.md` 的資料夾裡的 `requirements.txt`（和上架檢查同一批檔案）。顧問的 bash 與 stdio MCP 把這個環境的 `bin` 排在 `PATH` 最前面；主管不用。創作者說明：`docs/creator/python-packages.md`。
- 記憶體上限（2026-10-30 設計，2026-10-31 實測無法生效）：沙盒腳本在降權前嘗試把自己放進 cgroup v2 `agenthub-sandbox`（`memory.max` 6 GiB）。但 Sprite 的 cgroup 根目錄（命名空間的根）本身有程序，核心不准在那層啟用記憶體控制器（`EBUSY`）。原本設計成設定失敗就不執行，10/30 上線後讓已更新的 Sprite 上顧問的每個指令都失敗，10/31 改成設不起來就照常執行。目前沙盒程序沒有記憶體上限，吃光記憶體仍可能拖垮整台 Sprite（runtime 的存活檢查會把這種中斷標成失敗）。
  - 2026-11-03 臨時 Sprite 實測：沙盒程式以約 0.5 GB/秒吃光記憶體（開始時可用約 7.3 GB）後，核心沒有砍單一程序，整個 Sprite 約 2.5 分鐘沒有回應，接著所有程序一起被重啟（pid 重新編號、核心開機時間連續，不是 VM 重開；另一次等了約 11 分鐘）。推測外層的記憶體群組是整組一起砍，所以沙盒腳本設的 `oom_score_adj=1000` 在這種情況下沒有作用。命名空間根目錄的 `cgroup.controllers` 有 `memory`、`memory.max` 是 `max`。
  - 2026-11-03 修正：根目錄裡只有 Sprite 的 `tini`、`tail` 與 exec 開的 shell（服務各自在 `svc.<名稱>` 子群組）。沙盒腳本在啟用記憶體控制器前，先把根目錄的程序搬到 `init` 子群組，之後 exec 開的程序也落在 `init`，根目錄保持空的。Sprite 重啟後 cgroup 恢復原狀，所以每個沙盒指令都檢查一次。實測：exec、服務重啟、建立服務都照常；沙盒程式吃到 6 GiB 時核心只砍它（`memory.events` 的 `oom_kill` 加 1），runtime 與 Sprite 照常回應。`probe-sandbox.ts` 驗收這兩項。搬移時剛好有新程序進根目錄會讓那次設定失敗（照常執行、不在群組裡），下一個指令會再試。
- runtime 的 `GET /runs/:id`（2026-10-30）：平台確認 run 是否還活著。以平台附上的資料庫通行證查這個 run，RLS 只放行本專案，查得到才回答 `{ active }`，否則 401。平台的請求要帶 Fly 驗證（`authorization`，Fly 驗證後拿掉）。限制：runtime 被砍時沙盒裡若還有指令在跑，Sprite 要等它們結束才重啟 runtime，期間判斷不了（2026-10-31 實測）。
- runtime 的 `POST /runs/:id/stop`（2026-11-05）：使用者按停止時平台呼叫，驗證方式與 `GET /runs/:id` 相同，查得到才中止，回答 `{ stopped }`。

**驗收**：在真的 Sprite 上，以 agent 身分嘗試以下動作，全部都必須失敗：`env` 看到金鑰、`cat ~/agenthub/.env`、`read_file` 讀 `.env`、建立指向 `.env` 的 symlink 後讀取、讀 runtime 程序的 `/proc/<pid>/environ`、`sudo -n true`、存取 `/.sprite/api.sock`。另外 runtime 帳號要仍能使用 `/.sprite/api.sock`（保持喚醒），沙盒裡要找得到 node 與 python3。腳本：`apps/web/scripts/probe-sandbox.ts`（2026-10-13 12 項全部通過）。2026-11-04 加上雲端資料夾同步：把 `/shared` 裡的資料夾換成指向顧問私人目錄的 symlink 後照 runtime 的方式同步，必須還原成真的資料夾、沒有寫進顧問目錄；以 `agent` 直接跟著 symlink 寫也必須失敗（尚未在 Sprite 上跑）。

## 5b. 平台代管 MCP 的 Sprite（子專案 3b）

每個代管 MCP 版本一台 Sprite（`agenthub-mcp-<版本 id 去掉連字號後前 12 碼>`），上面只有這個 MCP 的程式與創作者金鑰，沒有任何平台金鑰。

| 帳號 | 用途 | sudo |
|---|---|---|
| `sprite` | 平台的部署腳本（下載套件、寫狀態） | 有 |
| `mcp` | 創作者的程式：解壓、讀 `mcp.json`、安裝相依套件、執行 | 沒有 |

```text
/srv/agenthub-mcp/           755 root
/srv/agenthub-mcp/deploy/    700 sprite     部署腳本（含一次性下載網址）、state.json、log.txt；mcp 進不去
/srv/agenthub-mcp/app/       700 mcp        創作者的程式與 .venv／node_modules
/srv/agenthub-mcp/env.sh     440 root:mcp   創作者金鑰與平台變數；mcp 只能讀，改不了
/srv/agenthub-mcp/path       644 root       node、python 的真實路徑（不經過 /.sprite/bin 的包裝腳本）
```

- 執行路徑：`sudo unshare --mount` → `/usr/local/bin/agenthub-mcp-run` 確認在獨立的掛載命名空間、用 `/dev/null` 蓋掉 `/.sprite/api.sock` → `setpriv` 降權成 `mcp` → `env -i` 清空環境 → 降權**之後**才載入 `env.sh`。
- 閘道以平台的 Sprites token 通過 Fly 驗證（Fly 驗證後拿掉 `Authorization`，到不了程式），`X-AgentHub-Token` 帶創作者通行證；程式以 `AGENTHUB_MCP_URL` 為 `aud` 驗證。
- 下架由資料庫函式 `retire_hosted_mcp_version` 鎖住版本後檢查有沒有專案在用，與 `hire_agent`（對版本 `for share`）互斥。
- 代管程式可以連外；背景程式在 Sprite 休眠時會被暫停。營運者可用 `apps/web/scripts/hosted-mcp.ts disable <版本 id>` 停用。

**驗收**：`apps/web/scripts/probe-hosted-mcp.ts` 以真的 Sprite 部署 Python 與 Node 範本，以 `mcp` 身分嘗試讀部署腳本、存取 `/.sprite/api.sock`、改寫 `env.sh`、`sudo -n true` 都必須失敗；`Authorization` 不能到達程式；金鑰更新後重啟生效（2026-10-15 25 項全部通過）。

## 6. 子專案進度

| # | 子專案 | 狀態 | 文件 |
|---|---|---|---|
| 1 | 平台金鑰隔離（A：分開帳號；C：只限自己專案的權限） | ✅ A 已上線（2026-10-13）；✅ C 已上線（2026-10-14，改用專案專用 runtime 帳號） | `docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md`、`docs/superpowers/specs/2026-10-14-runtime-scoped-access-design.md` |
| 2 | 顧問之間隔離 | ✅ 已上線（2026-10-14） | `docs/superpowers/specs/2026-10-13-consultant-isolation-design.md` |
| 3 | 遠端 MCP 的平台支援（閘道與通行證、自己架與平台代管、用量、版本、大量資料慣例） | ✅ 3a＋3c 已上線（2026-10-14）；✅ 3b 平台代管的部署與呼叫已上線（2026-10-15，API；創作者頁面待計畫 B），正式環境經閘道驗收 | `docs/superpowers/specs/2026-10-14-remote-mcp-design.md`、`docs/superpowers/specs/2026-10-15-hosted-mcp-3b-design.md` |
| 4 | 金融顧問改走遠端 MCP（`agenthub-fintech-agents`） | ✅ 2026-10-14 上線：MCP server 在 `agenthub-fintech-mcp.vercel.app`，正式環境經閘道驗收（13 次工具呼叫全部成功） | `agenthub-fintech-agents/docs/superpowers/specs/2026-10-14-fintech-remote-mcp-design.md` |

## 7. 已知缺口與待辦

- 單一顧問模式的原始工具輸入輸出會送到瀏覽器（見第 3 節）。
- 組織（2026-11-09）：單一顧問模式下，一般組織成員在串流裡仍看得到原始工具輸入輸出（例如用 `read_file` 讀 SKILL.md），與第 3 節「單一顧問模式下……原始工具輸入輸出仍會隨串流送到瀏覽器」是同一個已知缺口；規格 §6 接受目前不修。
- 組織（2026-11-09）：成員離開或範本下架時，已經開始的 run 會繼續使用它載入的組織顧問（包含該 run 內新的派工與討論，直到 run 的時間上限）；只有遠端 MCP 呼叫會立刻被擋。下一則訊息開始新的 run 才會被擋。
- 組織（2026-11-09）營運注意：`agent_templates.creator_id` 對 profile 刪除是 cascade，刪除使用者帳號會一併刪掉他建立的組織範本（成員的副本改顯示「已下架」、代管 MCP 版本被刪、其 Sprite 變孤兒）。刪使用者之前，先把他的組織範本的 `creator_id` 改成該組織的某位管理員。
- 組織（2026-11-09）：`org_instance_problem` 給 `authenticated` 執行（`agent_instances` 的 policy 要用）。任何帶 `authenticated` JWT 的人都能呼叫，不只 runtime 帳號，網站使用者用自己的 Supabase 登入通行證直接打 PostgREST 也可以。知道專案 id 與組織 id 就能問出「這個專案的擁有者是不是那個組織的成員」，知道範本 id 與組織 id 就能問出「那個範本是不是該組織已上架的範本」。只回答是或否，不洩漏名稱與內容；id 都是隨機 uuid，網站也不會把別人的專案 id 給出去。
- 組織（2026-11-09 實測，`runtime-access.test.ts`「Storage 下載快取只限同一張通行證」）：Storage 的下載有快取，以**通行證**為單位。runtime 被擋之前用某張通行證下載過的 skill zip，被擋之後用**同一張**通行證還下載得到（實測至少 5 秒；多久沒測，推測最長到通行證過期，目前 1 小時）。以下都照 policy 拒絕：別的專案的通行證（即使 A 剛下載過）、同一個 runtime 帳號重新登入拿到的新通行證、從沒下載過的通行證，以及 `list`。所以快取不會讓跨專案或跨租用者拿到檔案，影響只在「被擋前已經拿過這個 zip 的同一台 runtime」。而 skill 檔案在租用後本來就已裝在專案的 Sprite 上，真正擋呼叫的是「runtime 讀不到這位顧問」，不靠 zip 下載不到。
- 平台代管 MCP：`mcp-bundles` 尚未設檔案大小上限（大小在開始部署時檢查）。閘道對 `tools/call` 不重送（先以不帶通行證的 HEAD 叫醒 Sprite），失敗版本與孤兒套件由 Vercel 每日排程清理（需設定 `CRON_SECRET`）。
- 2026-10-13 之前，agent 讀得到每台 Sprite `.env` 裡的平台金鑰且可 sudo 成 root；A 上線後已封住，但金鑰仍存在 `.env`（只有 runtime 讀得到），C 上線後才會移除。
- 子專案 1 上線前，平台金鑰已存在每台 Sprite 的 `.env`；全部重新佈建後應輪換 Supabase secret key 與 Vertex 金鑰。
- 雲端資料夾（2026-11-03）的已知限制：
  - 交付失敗時（例如登記被拒），runtime 刪不掉剛上傳的物件（沒有 delete 權限），會留下沒有資料表紀錄的物件，刪專案時才清掉。
  - 同步的權限分離（`/shared` 寫入改由 `agent` 執行）與交付時「讀不到的檔案交不出去」只有在 Linux／Sprite 上才驗得到，本機測試涵蓋不到；Sprite 上的驗收在 `probe-sandbox.ts`。
  - `agent` 帳號仍可能被 symlink 騙去寫進或改權限（chmod）它自己的家目錄或主管的私人 `/tmp`；這些都是 `agent` 本來就能寫的地方，目前沒有可利用的目標。chmod 前會先確認暫存檔仍是一般檔案，只能縮小、不能消除這個空檔。
  - 舊制檔案（`project-files/<專案>/<檔名>`）以 `apps/web/scripts/migrate-project-files.ts` 搬進「我上傳的」後，新 runtime 第一次同步會清掉舊 runtime 留在 `/shared` 第一層的副本與舊的 `/shared/.sync.json`：只刪舊紀錄裡列出、且現在是一般檔案的第一層項目（symlink、資料夾不碰，舊紀錄本身是 symlink 就整個略過），以 `agent` 執行。`/shared` 是 2770、沒有 sticky bit，任何顧問本來就能刪第一層的項目，所以這不會多給誰能力；但顧問自己在第一層建立、剛好與舊紀錄裡的檔名同名的一般檔案也會被刪掉。有刪不掉的就保留舊紀錄，下次同步再試。
  - 同步寫入 `/shared` 的每個指令最多 120 秒（在 `agent` 帳號裡以 `timeout -k 5` 執行），一次同步合計最多 5 分鐘：用完就略過還沒寫入或刪除的檔案，留在同步紀錄裡下次 run 再試。顧問能讓檔案的寫入失敗或逾時，最壞讓每次 run 的準備階段多等約 5 分鐘，但不能讓 run 永遠卡住。被砍掉時可能在該資料夾留下 `.agenthub-sync.*` 暫存檔，同步不會碰它。
