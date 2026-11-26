# 執行環境改用 E2B（保留切回 Sprite）設計

日期：2026-11-25
狀態：設計中，待使用者核可

## 1. 目的與原因

Fly.io 對新帳號已沒有免費額度，每專案一台的 Sprite 會持續花錢。改把專案 runtime 與平台代管 MCP 搬到 E2B（Hobby 方案一次性 $100 額度、暫停時不收運算費）。

E2B 也不是長期免費，額度用完就要付費或換家，所以**每個專案（與每個代管 MCP 版本）記住自己跑在哪一家**，之後能逐台搬回 Sprite 或搬去別家，不必一次全部重建。

這次的範圍：**全部搬到 E2B**（含 Demo 專案「金融科技展 Demo」），Sprite 的實作保留可用。

## 2. 目標、非目標、反目標

目標
- 新專案、新代管 MCP 版本預設開在 E2B；由一個環境變數決定預設執行環境。
- 既有專案與代管 MCP 版本用腳本逐台搬到 E2B，搬完驗證、才刪舊 Sprite。
- 之後可以用同一支腳本把任一專案搬回 Sprite。
- 沙盒隔離（[security-model.md](../../security-model.md)）在 E2B 上與 Sprite 上等強：顧問帳號、獨立掛載命名空間、私人 /tmp、6 GiB 記憶體群組、runtime 不持有平台金鑰。
- 使用者感受不變：休眠、有請求自動叫醒、對話中不會被暫停。

非目標
- 不做第三家（Daytona、Modal 等），但介面不擋未來加。
- 不搬顧問工作目錄裡的暫存檔與顧問自己裝的套件（雲端資料夾、記憶、skill 都在 Supabase，會照常同步回來）。
- 不改資料庫既有的 `sprite_*` 欄位名稱（見 §6.2）。
- 不做執行環境的自動切換（例如額度用完自動搬）；切換一律由人跑腳本。
- 不做額度用量提醒（使用者自己看 E2B 後台）——待使用者確認，若要做另開一節。

反目標（技術上能動但算失敗）
- 搬遷造成雲端資料夾、記憶、對話紀錄任何遺失。
- E2B 上的隔離比 Sprite 弱（例如顧問帳號能以 root 執行、讀到別的顧問目錄、讀到 runtime 的 `.env`）。
- 對話跑到一半沙盒被暫停，run 被標成中斷。
- runtime 或沙盒拿到 E2B API key 或 Fly token。

## 3. 已實測的事實（2026-11-25，E2B JS SDK `e2b@2.64.0`）

驗收腳本在 `.superpowers/sandbox-eval/`（不進 git）：`e2b-probe.mjs`、`e2b-memory.mjs`、`e2b-timeout.mjs`、`e2b-clock.mjs`、`e2b-envd.mjs`。

| 項目 | 結果 |
|---|---|
| 預設 base 範本 | Debian 12、node 20.9、python 3.11.6（系統 pip 在 `/usr/local/lib/python3.11`）、2 vCPU、473 MB 可用、磁碟 22G |
| 預設帳號 | `user`（家目錄 `/home/user`），**免密碼 sudo**；`commands.run(cmd, { user: 'root' })` 可直接以 root 執行 |
| 隔離能力 | root `useradd`／`groupadd`、`unshare --mount`＋`mount --bind`、`setpriv` 降權都可用；照 `SANDBOX_WRAPPER_SCRIPT` 做一遍全部成功 |
| cgroup v2 | 有 memory 控制器；照 Sprite 做法把根目錄程序搬到 `init` 子群組後可開 `+memory`，超過上限只砍群組內程序（exit 137） |
| 記憶體 | Hobby 可自建 8192 MB 範本（建置 83 秒），實際可用 7.7 GB，吃 6 GiB 正常。Hobby 上限 8 vCPU／8 GiB |
| 對外網址 | `https://${sbx.getHost(8080)}`；`network: { allowPublicTraffic: false }` 時沒帶 `e2b-traffic-access-token` 回 403 |
| 通行證 | `sbx.trafficAccessToken` **只在 `create`／`connect` 時拿得到**，`Sandbox.getInfo` 不回傳；`connect` 會叫醒沙盒 |
| 暫停／叫醒 | `lifecycle: { onTimeout: 'pause', autoResume: true }`；暫停後一個 HTTP 請求約 0.3 秒叫醒（8 GB＋佔 2 GiB 時 291 ms），同一個程序（pid 不變）繼續跑，檔案與帳號保留 |
| 逾時怎麼算 | **HTTP 請求不會延後逾時**（每 15 秒一個請求，到期時間照樣倒數）；到期後暫停，下一個請求叫醒並給至少 5 分鐘。從外部 `Sandbox.setTimeout(id, ms)` 可延長 |
| 連續 1 小時上限（`e2b-hour-cap.mjs`，每 2 分鐘延長 5 分鐘） | 第 56 分鐘起延長被**默默截在**建立後 60 分鐘；到點後沙盒**被暫停、沒有被刪除**（`getInfo` 回 `paused`，`connect` 可叫醒）。暫停中對它 `setTimeout` 會丟 `SandboxNotFoundError`（名稱會誤導，沙盒其實還在）。暫停後程序是否保留這次沒驗到（測試程序 pid 沒抓到），但一般暫停會保留程序（上一列） |
| 時鐘 | 暫停 60 秒再叫醒，與外界誤差 0.1 秒；HTTPS 正常 |
| 標頭轉送 | E2B **不會拿掉** `e2b-traffic-access-token` 與 `authorization`，兩者都原封不動到達沙盒內的程式 |
| Node 版本 | base 範本是 node 20.9，但 runtime 要求 `node >=22`（`packages/runtime/package.json` engines、esbuild `target: 'node22'`），**直接用 base 跑不了 runtime** |
| envd（E2B 在 VM 內的管理程式） | root 執行、聽 `*:49983`；顧問帳號打得到 `/health`（204），但要求以 root 啟動程序回 **401**（需要 access token）。沙盒內另有 sshd（22）、rpcbind（111） |

E2B Hobby 限制（官方定價頁與 billing 文件）：無月費、一次性 $100；$0.000014/vCPU-秒、$0.0000045/GiB-秒（2 vCPU＋8 GiB 約 $0.23/小時）；暫停、磁碟不收費；暫停保留不限期；同時**執行中**最多 10 台；單次連續執行最多 1 小時（暫停後重算）；每台 10 GiB 磁碟。Pro $150/月：100 台、24 小時。

## 4. 限制

- 遵守 repo `CLAUDE.md` 開發原則：最簡單、模組化、不留相容垃圾、用專案已有依賴（新增 `e2b` 套件是必要的）。
- runtime 不能持有任何平台金鑰（子專案 1-C）。E2B API key 只在 Vercel。
- Vercel Hobby 函式最長 300 秒。
- push 到 `main` 就上 production；migration 由使用者貼到 Supabase Dashboard 套用。
- `@fly/sprites`、E2B SDK、AI SDK v7、Next 16 的 API 寫之前先查文件。

## 5. 方案（使用者選方案一）

| 方案 | 做法 | 取捨 |
|---|---|---|
| **一、統一的執行環境介面，兩份實作**（採用） | 把「開機／刪除／執行指令／寫檔／啟動服務／延長時間／轉送時的驗證標頭」抽成一個介面，Sprite 與 E2B 各一份；資料列記住自己在哪家 | 多一層介面與兩個欄位；換來每台可獨立搬、之後加第三家只要再寫一份實作 |
| 二、呼叫處直接判斷 | 每個呼叫 Sprite 的地方加 `if (host === 'e2b')` | 起步快，但判斷散在十幾個檔案，難維護 |
| 三、只留 E2B | 刪掉 Sprite 程式 | 最簡單，但額度用完要從 git 拼回舊版，不符合「怕額度用完要能切回」 |

## 6. 設計

### 6.1 執行環境介面

新增 `apps/web/lib/hosts/`：

- `types.ts`：`RuntimeHost` 介面與 `HostName = 'sprite' | 'e2b'`。
- `sprite.ts`：把現在 `lib/sprites.ts` 中與 Sprites API 打交道的部分搬進來，行為不變。
- `e2b.ts`：E2B 實作。
- `index.ts`：`hostFor(name)`，以及 `defaultHost()`（讀環境變數 `DEFAULT_RUNTIME_HOST`，預設 `e2b`）。

`RuntimeHost` 涵蓋的能力（命名與簽章留給實作者，以下是必須涵蓋的事）：

| 能力 | Sprite | E2B |
|---|---|---|
| 建立機器，回傳名稱、網址、通行證 | `getOrCreateSprite`（名稱 `agenthub-<id>`），通行證為 null | `Sandbox.create(範本, { timeoutMs: 5 分鐘, lifecycle: { onTimeout: 'pause', autoResume: true }, network: { allowPublicTraffic: false }, metadata: { kind, id } })`；名稱＝`sandboxId` |
| 刪除（已不在算成功；只刪自己的） | 現有 `deleteSpriteIfExists`（前綴檢查） | `Sandbox.kill(id)`；先用 metadata 確認是本平台、這個專案／版本的沙盒才刪 |
| 執行指令、寫檔 | `execFile`、`filesystem().writeFile` | `commands.run`、`files.write` |
| 常駐服務：啟動、重啟、讀最後輸出 | Sprites services API | 見 §6.4 |
| 延長存活時間 | 不需要（Sprite 靠 runtime 的 Tasks API） | `Sandbox.setTimeout(id, 5 分鐘)` |
| 轉送請求時的驗證標頭 | `authorization: Bearer <FLY_SPRITES_TOKEN>` | `e2b-traffic-access-token: <該台通行證>` |

專案 runtime 與代管 MCP 共用這個介面；代管 MCP 現有的 `HostedSpriteOps`（`lib/services/hosted-mcp.ts`）改為依版本的 host 取對應實作，業務規則不動。

### 6.2 資料庫

新 migration：

- `projects` 加 `host text not null default 'sprite' check (host in ('sprite','e2b'))`、`host_token text`。
- `hosted_mcp_versions` 加同樣兩欄。
- 既有資料列預設 `sprite`；新列由應用程式寫入 `defaultHost()`。
- E2B 的 `sandboxId` 存在既有的 `sprite_name`，網址存在 `sprite_url`，通行證存在 `host_token`。

欄位權限：`security-model.md` 第 4 節已列 runtime 對 `projects`、`hosted_mcp_versions` 沒有任何權限，只有 `service_role` 讀寫，所以 `host_token` 不會被 runtime 或使用者讀到。先更新該節表格（說明新欄位）再寫 migration，`supabase/tests/runtime_access.sql` 加一條斷言：runtime 讀不到 `projects.host_token`。

不改 `sprite_*` 欄位名稱：名稱只是舊稱呼，改名會牽動前端 `sprite_status` 等十幾處，沒有行為上的好處。**我決定**，實作者若覺得值得可在另一張單處理。

### 6.3 E2B 範本

- 以 SDK 的 `Template().fromBaseImage()` 加建置步驟建兩個範本，腳本 `apps/web/scripts/e2b-templates.ts`（可重複執行）：
  - `agenthub-runtime`：2 vCPU、8192 MB（對應 Sprite 上 6 GiB 沙盒群組＋runtime 本身）。
  - `agenthub-mcp`：1 vCPU、2048 MB（代管 MCP 只跑創作者的單一程式）。**我決定**，實測不夠再調。
- **語言工具建進範本**（**我決定**）：佈建跑在 Vercel `after()` 裡（最長 300 秒），redeploy 與搬遷每台都會重跑，裝 JDK、Go 這類大東西會逾時又浪費；所以不變的工具放範本，佈建腳本只做帳號、目錄、腳本、`.env` 這些會變的事。
  - `agenthub-runtime` 範本：Node 22 LTS（取代 base 的 20）、npm、python3＋pip、numpy、pandas、go、java（JRE 即可）、ruby、git、curl。標準＝`probe-sandbox.ts` 現有的語言清單全部通過，顧問在兩家看到的工具一致。
  - `agenthub-mcp` 範本：Node 22 LTS、python3＋pip（`mcp.json` 的 `runtime` 只有 node／python）。
  - Sprite 映像上還有其他工具（字型等），清單以外的不保證；有顧問反映缺什麼再加進範本。
- 測試期留下的 `agenthub-eval-8192m` 範本在搬遷完成後刪除。

### 6.4 佈建與常駐服務（E2B）

佈建流程與 `installRuntime` 相同：讀 `$HOME` 取 base（E2B 上是 `/home/user/agenthub`）→ 下載 `main.js` → 寫 `.env` → 跑 `sandboxSetupScript` → 啟動服務 → 等 `/health`。

`sandboxSetupScript` 裡 Sprite 專屬的部分要依 host 分開：
- `/.sprite/bin` 語言包裝腳本的 `languages_env`／`languages_paths` 補齊：只在 Sprite 做。
- 預先安裝 numpy、pandas：Sprite 維持佈建時用 pyenv 的 pip 安裝；E2B 已在範本裡，佈建不做。
- `SANDBOX_WRAPPER_SCRIPT` 的 `[ ! -S /.sprite/api.sock ] || ...` 在 E2B 上自然略過，不用改；cgroup 那段兩邊一樣。
- E2B 上沒有對應 `/.sprite/api.sock` 的東西要遮：envd 需要 access token（實測 401）。

常駐服務：E2B 沒有服務管理員，改成：
- runtime：以 `commands.run(RUNTIME_SUPERVISOR …, { background: true, timeoutMs: 0 })` 啟動看守腳本。看守腳本在 E2B 上要**自己重啟 node**（迴圈：node 結束 → 砍沙盒帳號程序 → 稍等 → 重啟），輸出寫到 `base/runtime.log`（保留最後一段即可）。Sprite 上維持現狀（服務管理員負責重啟）。
- 重新部署（redeploy）：停掉舊的看守腳本與 node，再啟動新的。
- 沙盒若因任何原因冷開機（程序全沒了），`/health` 會失敗：轉送對話遇到連不上時，平台對 E2B 專案重新執行「啟動服務」一次再重試；仍失敗就照現在的錯誤訊息回應。
- 代管 MCP 的 `deploy` 與 `mcp` 兩個服務同理：背景指令＋輸出寫檔；`serviceLog` 讀檔尾 100 行；`applyEnv` 重啟＝停掉再啟動。部署腳本 `deployScript` 裡「服務結束會被重啟所以 `exec sleep infinity`」的處理在 E2B 上不需要，但保留也無害，實作者決定。

### 6.5 轉送與驗證標頭

所有連到 runtime 或代管 MCP 的地方，改成向該資料列的 host 取驗證標頭，不再直接用 `env.spritesToken`：
- `lib/sprites.ts` 的 `forwardChat`、`waitForHealth`
- `lib/run-liveness.ts` 的 `askSprite`
- `lib/services/remote-mcp.ts` 的 `edgeToken`（改成帶標頭物件）與 MCP 閘道 `forwardToCreator`
- `lib/hosted-sprite.ts` 的 `listTools`

代管 MCP 的標頭：Sprite 上 `authorization` 放 Fly token（Fly 驗證後拿掉），創作者通行證在 `x-agenthub-token`。E2B 上不送 `authorization`，創作者通行證照舊放 `x-agenthub-token`，另加 `e2b-traffic-access-token`。創作者程式收到的通行證只能連回它自己那台沙盒（見 §7）。**我決定**。

E2B 的 `autoResume` 讓任何請求都能叫醒沙盒，所以 MCP 閘道「tools/call 先送 HEAD 叫醒再送一次」的邏輯照用；`forwardChat` 遇 502／503／504 重試的邏輯也照用。

### 6.6 防止對話中被暫停

E2B 的逾時不看流量（§3），所以：

- **runtime 發起的延長**：runtime `.env` 新增 `RUNTIME_HOST`（`sprite`／`e2b`）。`keepalive.ts` 在 `sprite` 時維持呼叫 Tasks API；在 `e2b` 時每 2 分鐘 `POST ${PLATFORM_URL}/api/runtime/keepalive`，帶這輪對話的專案通行證 `x-agenthub-token`（效期 20 分鐘，run 上限 15 分鐘＋30 秒收尾，夠用）。`stop()` 在 E2B 上不用做事，讓它自然在 5 分鐘後暫停。
- **平台端點** `POST /api/runtime/keepalive`：`requireProjectToken` 驗證 → 讀專案 → 若是 E2B，`Sandbox.setTimeout(sprite_name, 5 分鐘)`；Sprite 專案回 204 不做事。
- **轉送前先延長**：`forwardToRuntime` 對 E2B 專案先 `setTimeout` 一次，避免剛叫醒、runtime 第一次 keepalive 前就到期。
- **代管 MCP**：閘道在每次轉送前對 E2B 版本 `setTimeout(5 分鐘)`（一次 API 呼叫）。這樣連續使用時不會被中途暫停；閒置 5 分鐘後暫停。
- **代管 MCP 部署中**：佈建時把逾時設成 15 分鐘（部署腳本上限 9 分鐘），避免安裝做到一半被暫停；部署進度由讀取版本推進，每次讀取也延長。**我決定**。
- keepalive 失敗只警告，不讓 run 失敗（與現在一致）。`setTimeout` 丟 `SandboxNotFoundError` 時**不能**當成沙盒不見：要再用 `Sandbox.getInfo` 確認，`paused` 就忽略（下一個請求會叫醒它）。

Hobby 單次連續執行上限 1 小時（實測）：延長會被截在 60 分鐘，到點強制暫停、不會刪除。一個專案連續不停對話超過 1 小時才會碰到；當下的 run 會凍結，平台的存活檢查（對它送請求）會叫醒它，但 runtime 對外的連線（模型串流）多半已斷，這個 run 可能失敗，下一輪正常。目前用量不會碰到，記在已知風險。

### 6.7 選擇與切換執行環境

- `DEFAULT_RUNTIME_HOST`（Vercel 環境變數，預設 `e2b`）決定新專案、新代管 MCP 版本開在哪家。
- `FLY_SPRITES_TOKEN`、`E2B_API_KEY` 改成「用到才必填」：沒有 Sprite 資料列時不設 Fly token 也能運作。
- 搬遷腳本 `apps/web/scripts/move-host.ts`：

```
pnpm exec tsx scripts/move-host.ts --to e2b --project <id>     # 單一專案
pnpm exec tsx scripts/move-host.ts --to e2b --all              # 全部專案與代管 MCP 版本
pnpm exec tsx scripts/move-host.ts --to sprite --project <id>  # 搬回 Sprite
```

本機腳本（`move-host.ts`、`e2b-templates.ts`、`probe-*.ts`）照現行慣例讀 repo 根目錄 `.env`，`E2B_API_KEY` 與 `FLY_SPRITES_TOKEN`、`SUPABASE_SECRET_KEY` 一樣放在那裡（使用者已放好）。§7「只在 Vercel」指的是 runtime 與沙盒拿不到，不是本機不能有。

專案搬遷，每台：
1. 有 `running` 的 run 就跳過並列出（不搬正在對話的專案）。開始搬時把 `sprite_status` 設成 `provisioning`，對話路由會回「agent 環境還在準備中」，搬遷期間不會有新對話；失敗時改回 `ready`。**我決定**。
2. 在目標 host 佈建新機器、裝 runtime、等 `/health` 回本專案 id。
3. 一次更新資料列 `host`、`sprite_name`、`sprite_url`、`host_token`、`sprite_status='ready'`。
4. 刪除舊機器。新機器失敗就刪掉新機器、保留舊的與原資料列，不更新資料庫。

代管 MCP 版本搬遷（`published`、`ready` 才搬；`disabled`、`retired`、`failed` 不搬）：
1. 在目標 host 佈建新機器，用 Storage 裡同一份 bundle 與 Vault 裡的金鑰部署。
2. 等安裝完成、啟動 `mcp` 服務、`listTools` 成功。
3. 更新資料列，刪舊機器。失敗同上回復。

全部搬完後跑一次 `smoke.ts`，並對 Demo 專案實際問一題確認三位顧問都能回答。

### 6.8 代管 MCP 的「先認領再建立」

現在以固定名稱 `agenthub-mcp-<版本 id 前 12 碼>` 先寫進 `sprite_name` 認領，再建立 Sprite，保證不重複建立、不留沒有紀錄的 Sprite。E2B 的 `sandboxId` 建立後才知道，所以認領與記錄要分兩步；做法由實作者決定，但要守住同樣兩件事：同一版本只會有一個請求去建立；建立到一半失敗時，清理排程找得到那台（建立時帶 `metadata: { kind: 'mcp', version_id }`，清理時用 `Sandbox.list` 依 metadata 找出沒有對應資料列的沙盒）。專案的沙盒同樣帶 `metadata: { kind: 'project', project_id }`。

### 6.9 沙盒整台不見時

實測 1 小時上限只會暫停，所以沙盒整台消失只剩少見的情況：被手動刪除、額度用完後 E2B 的處理（未知）、E2B 故障。重建後 `sandboxId`、網址、通行證都會換，不能像 Sprite 用同一個名字重建。

判斷「不見」一律用 `Sandbox.getInfo` 回 NotFound（不用 `setTimeout` 的錯誤，見 §6.6）。處理方式（**我決定**，因為很少發生，不值得在每條請求路徑上加自動重建與重建競爭的處理）：
- 專案：轉送對話或存活檢查連不上、且 `getInfo` 確認不見時，把專案標成 `sprite_status='error'`，訊息寫「agent 環境已不存在，請重新建立」。專案頁現有的「重新建立環境」按鈕（`/api/projects/[id]/provision`）對 E2B 專案建立新沙盒並更新資料列。
- 代管 MCP：閘道回 503「這個工具服務暫時無法使用」並在 log 記下版本；由營運用 `move-host.ts`（目標同一家也可以）重新部署。

### 6.10 其他會動到的地方

- `redeploy-runtime.ts`：依專案 host 取實作。
- `probe-sandbox.ts`、`probe-hosted-mcp.ts`：加 `--host`，兩家都要能驗收。
- `app/api/cron/hosted-cleanup`、`scripts/hosted-mcp.ts`：依版本 host 刪除。
- `smoke.ts`、`seed-demo.ts`、`e2e-*.ts` 裡寫死 Sprite 的地方。
- 文件：repo `CLAUDE.md` 架構圖與說明、`docs/security-model.md`（E2B 的 envd 實測、sshd、通行證存放）、`README.md`、`docs/creator/hosted-mcp.md` 若提到 Sprite。

## 7. 安全

- E2B API key 只放 Vercel；runtime `.env` 只多 `RUNTIME_HOST`，沒有新金鑰。
- 每台沙盒的通行證只存在 `service_role` 才能讀的欄位，也不放進 `PROJECT_COLUMNS`（不會隨專案資料送到瀏覽器）。
- E2B 會把通行證標頭轉進沙盒內的程式（實測）。runtime 本來就受信任；代管 MCP 的創作者程式會看到**自己那台**的通行證，只能用來連回自己，拿不到別台、也拿不到平台金鑰。`security-model.md` 第 5b 節「`Authorization` 不能到達程式」是為了 Fly token（全站共用）；改寫成「平台共用的憑證不能到達程式；E2B 每台自己的通行證可以」，`probe-hosted-mcp.ts --host e2b` 依此斷言：程式看不到 Fly token、看不到別台的通行證。**我決定**。
- envd 需要 access token，顧問帳號無法透過它以 root 執行（實測 401）。實作者在 `probe-sandbox.ts` 的 E2B 模式加上這一項（顧問帳號打 envd 啟動程序必須失敗），之後 E2B 改版時能發現。
- 沙盒內 sshd 聽 22 埠：顧問帳號沒有密碼、沒有金鑰；實作者在驗收腳本確認顧問帳號無法經 sshd 登入其他帳號。
- 刪除前用 metadata 確認是本平台的沙盒（取代 Sprite 的名稱前綴檢查）。

## 8. 已知風險

- **額度**：$100 用完要付費，或用 `move-host.ts` 搬回 Sprite（這正是保留切換的原因）。
- **Hobby 限制**：同時執行中 10 台（暫停的不算）；連續執行 1 小時強制暫停。
- **E2B 改版**：autoResume、`allowPublicTraffic` 等是較新的功能；鎖定 SDK 版本，升級前跑兩支驗收腳本。
- **搬遷不帶顧問暫存檔**：顧問寫在自己工作目錄、沒有交付到雲端資料夾的檔案會消失。

## 9. 部署順序

1. 使用者在 Supabase Dashboard 套用新 migration（既有列預設 `sprite`，舊程式不受影響）。
2. 使用者在 Vercel 設定 `E2B_API_KEY`，`DEFAULT_RUNTIME_HOST` 先設 `sprite`。
3. push web、`publish-runtime`、`redeploy-runtime.ts`（行為不變，只是 runtime 多認得 `RUNTIME_HOST`）。
4. 跑 `e2b-templates.ts` 建範本；`probe-sandbox.ts --host e2b`、`probe-hosted-mcp.ts --host e2b` 通過。
5. 先用 `move-host.ts --project` 搬一個測試專案、跑 smoke；通過後 `--all`。
6. Vercel `DEFAULT_RUNTIME_HOST` 改 `e2b`。
7. 確認 Fly 上 `agenthub-` 開頭的 Sprite 都已刪除（不碰 `qm-*` 等別人的 Sprite）。

## 10. 留給實作者

- `RuntimeHost` 的確切方法名稱、檔案切分、現有 `lib/sprites.ts` 拆多少到 `hosts/sprite.ts`。
- 看守腳本的重啟間隔與日誌保留方式。
- 單元測試以假的 host 實作（與現在 mock Sprites 的方式一致）；兩支 probe 在真的 E2B 上驗收。
- `move-host.ts` 一次搬幾台（依 Hobby 同時 10 台的限制）。
