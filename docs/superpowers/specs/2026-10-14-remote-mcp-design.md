# 遠端 MCP 的平台支援（子專案 3）技術規格

- 日期：2026-10-14
- 狀態：設計已逐段確認，待最終審閱
- 目標：創作者的腳本與資料放在遠端 MCP（創作者自己架或平台代管），agent 與租用者只拿得到工具回傳的結果；呼叫要能驗證、撤銷、計量
- 前提：子專案 1-A、2 已上線（沙盒拿不到平台金鑰、顧問之間隔離）
- 長期參考：`docs/security-model.md`

---

## 0. 現況

平台已支援 `http` 型 MCP：創作者在範本設定網址與標頭，標頭裡的 `${KEY}` 由租用者啟用時填入的金鑰代入（存在 Vault，`get_project_secrets` 取出）。問題：

- 金鑰由租用者填 → 租用者拿得到創作者 MCP 的金鑰，可以繞過平台直接呼叫；平台算不到用量；取消租用後金鑰仍有效。
- 創作者 MCP 的網址存在 `agent_instances.mcp_servers`，Sprite 讀得到。
- 不會寫程式的創作者沒辦法架 MCP server。

## 1. 決策紀錄

| 項目 | 決定 |
|---|---|
| 代管方式 | 創作者自己架、平台代管兩種都支援；一次設計，分 3a／3b／3c 實作 |
| 連線路徑 | 一律經過平台閘道 `/api/mcp/<顧問id>`；runtime 不直接連創作者 |
| runtime → 閘道 | 專案通行證：Vercel 每次轉送對話時簽發，只對該專案有效、20 分鐘過期（1-C 會沿用同一張） |
| 閘道 → 創作者 | 創作者通行證：ES256 JWT，平台簽發，5 分鐘過期；平台在 `/.well-known/jwks.json` 公開公鑰 |
| 原本的 `http` 型 | 保留，用於「租用者自己的第三方服務」（金鑰仍由租用者填）；創作者自己的 MCP 改用新的 `remote` 型 |
| 計費 | 先只記用量（`mcp_usage`），不收費（依產品決策：前期不收費、金流未串） |
| 版本 | 自己架：創作者自行管理，租用時鎖定設定（沿用現有快照）。平台代管：每次發布一個版本、一台 Sprite；租用時鎖定版本；不做升級按鈕 |
| 大量資料 | 慣例：工具回傳短期有效的下載連結（創作者自己的儲存空間簽名網址），agent 在沙盒以 `curl` 下載；平台不代理 |

## 2. 3a：閘道、通行證、用量（創作者自己架）

### 2.1 範本格式

MCP 設定新增 `transport: 'remote'`：

```ts
{ name: string; transport: 'remote'; url: string }   // url 是創作者的 MCP 端點（streamable HTTP）
```

- `url` 只存在伺服器端可讀的位置（見 2.5），不寫進 Sprite 讀得到的 `agent_instances.mcp_servers`；`mcp_servers` 裡只留 `{ name, transport: 'remote' }`。
- `remote` 型不接受 `headers`、`required_secrets`（身分由平台通行證處理）。

### 2.2 專案通行證（runtime → 閘道）

- Vercel 的 `forwardChat` 轉送對話時，加上標頭 `x-agenthub-token`：HS256 JWT，內容 `{ project_id, exp: 現在 + 20 分鐘 }`，以 Vercel 環境變數 `RUNTIME_TOKEN_SECRET` 簽章。
- runtime 收到後只存在這次 run 的記憶體裡，用來連閘道；沙盒（agent）拿不到（1-A）。
- `.env` 新增不敏感的 `PLATFORM_URL`。

### 2.3 runtime

- `connectMcpServers` 遇到 `remote` 型：以 streamable HTTP 連 `${PLATFORM_URL}/api/mcp/${instanceId}`，標頭 `Authorization: Bearer <專案通行證>`。
- 工具名稱、前綴規則與其他 MCP 相同。

### 2.4 閘道 `/api/mcp/[instanceId]`（Vercel 路由）

1. 驗證專案通行證；查 `agent_instances`：存在、`role = 'consultant'`、`project_id` 與通行證相同。不符 → 401／403（取消租用後立即失效）。
2. 從伺服器端讀出這位顧問鎖定的遠端 MCP 目標（3a：創作者網址；3b：代管 Sprite 網址）。
3. 簽創作者通行證：

```json
{ "iss": "<平台網址>", "aud": "<MCP 目標網址>", "sub": "<顧問 id>", "project_id": "…", "template_id": "…", "exp": "<5 分鐘後>", "jti": "…" }
```

4. 轉送 MCP 請求（POST／GET／DELETE），請求與回應都以串流原樣傳遞；`Mcp-Session-Id` 等標頭照傳。創作者通行證**一律放在 `X-AgentHub-Token`**；自己架時 `Authorization: Bearer` 也放同一張（方便一般 MCP 框架檢查），代管時 `Authorization` 是 Fly 的 Sprites token（Sprite 網址驗證用）。創作者程式只要讀 `X-AgentHub-Token`，自己架與代管可共用同一份程式。
5. 請求本文是 JSON-RPC 且 `method = 'tools/call'` 時，回應結束後寫一筆 `mcp_usage`。
6. `maxDuration = 300`；單次工具呼叫超過 300 秒會被 Vercel 切斷（記為已知限制）。

### 2.5 資料庫

- 新表 `remote_mcp_targets`：`instance_id`、`mcp_name`、`kind ('self' | 'hosted')`、`url`（自己架）或 `hosted_version_id`（代管）。租用時（`hire_agent`）從範本複製。只有 `service_role` 能讀（runtime 讀不到；寫進 `docs/security-model.md` 權限表）。
- 範本端：`agent_templates.remote_mcp`（jsonb，`[{ name, url }]`），創作者頁面維護；`mcp_servers` 裡對應的項目只有 `{ name, transport: 'remote' }`。
- 新表 `mcp_usage`：`id`、`created_at`、`project_id`、`instance_id`、`template_id`、`creator_id`、`mcp_name`、`tool`、`ok`、`duration_ms`。只能新增；創作者頁面依 `template_id` 彙總。

### 2.6 簽章金鑰與公鑰

- ES256 私鑰放 Vercel 環境變數 `MCP_SIGNING_KEY`（PKCS8 PEM）；`kid` 取公鑰指紋。
- `GET /.well-known/jwks.json` 回傳公鑰；輪換時新舊兩把並列一段時間。

### 2.7 創作者端驗證

文件提供 Python（PyJWT＋JWKS）與 Node（`jose`）各一段驗證範例：從 `X-AgentHub-Token` 取通行證，檢查簽章、`iss`、`aud`、`exp`。不驗證的 MCP 仍可運作，但等於任何人都能呼叫——文件明講。

## 3. 3b：平台代管

### 3.1 創作者上傳

- 創作者頁面上傳 MCP 套件（zip，存 Storage bucket `mcp-bundles`，私有）：程式、資料、`mcp.json`：

```json
{ "runtime": "python", "start": "python server.py", "install": "requirements.txt" }
```

- 程式須在 8080 埠提供 MCP streamable HTTP；平台提供 Python（FastMCP）與 Node 範本。
- 代管 MCP 需要的金鑰在頁面填寫，存 Vault（`hosted_mcp_secrets`），只注入代管 Sprite；租用者與專案 runtime 都拿不到。

### 3.2 部署與版本

- 每次發布建立 `hosted_mcp_versions`（`id`、`template_id`、`version`、`bundle_path`、`sprite_name`、`status`、`log`、`tools`）。
- 部署：建立 Sprite `agenthub-mcp-<範本 id 前 8 碼>-v<version>` → 下載套件 → 依 `mcp.json` 安裝相依套件 → 以 Sprite 服務啟動（環境變數 = 創作者金鑰）→ 呼叫 `tools/list` 驗證，把工具清單與日誌存回 `hosted_mcp_versions`。
- 創作者確認工具清單後發布；新租用鎖定最新已發布版本，既有專案留在原版本。
- 沒有任何 `remote_mcp_targets` 指向某個版本時，可刪除該版本的 Sprite（手動腳本，不自動）。

### 3.3 存取

- 代管 Sprite 的網址使用 Fly 驗證（`auth: 'sprite'`，`Authorization` 帶 Sprites token），只有 Vercel 閘道連得到；閘道仍在 `X-AgentHub-Token` 附上創作者通行證，讓同一份程式在自己架與代管之間互換。
- 沒人使用時 Sprite 休眠；喚醒需數秒（記為已知限制）。

### 3.4 誰看得到什麼

| | 程式碼與資料 | 創作者的金鑰 | 工具結果 |
|---|---|---|---|
| 租用者 | ❌ | ❌ | ✅ |
| 專案 Sprite 裡的 agent | ❌ | ❌ | ✅ |
| 其他創作者 | ❌ | ❌ | ❌ |
| 平台營運者 | ✅（須寫進創作者條款） | ✅ | ✅ |

## 4. 3c：版本與大量資料

- 版本規則見 1. 決策紀錄；3b 已含版本資料表。
- 大量資料慣例寫進創作者文件（`docs/creator/remote-mcp.md`）：工具回傳 `{ "download_url": "…", "expires_in": 600 }`，連結由創作者自己的儲存空間簽發；agent 的 prompt 說明「看到 download_url 就在沙盒以 curl 下載後再計算」。
- 平台不代理下載：代理需要 agent 在沙盒持有平台通行證，與 1-A 的原則衝突。

## 5. 錯誤處理

| 情境 | 處理 |
|---|---|
| 專案通行證缺少、過期、專案不符 | 閘道回 401／403；runtime 把該 MCP 列為「目前無法使用」（現有警告機制） |
| 顧問已被移出專案 | 閘道 403；用量不記 |
| 創作者 MCP 無回應／5xx | 閘道回 502，用量記 `ok = false` |
| 代管 Sprite 喚醒中 | 閘道對 502／503 重試（沿用 `forwardChat` 的重試） |
| 代管部署失敗 | 版本狀態 `failed`，日誌顯示給創作者，不可發布 |
| 簽章金鑰未設定 | 閘道回 500 並記錄；不以未簽名的請求轉送 |

## 6. 測試

1. 單元：專案通行證簽發與驗證（過期、專案不符）；創作者通行證欄位；JWKS 格式；JSON-RPC `tools/call` 判斷；`remote` 型 schema（不接受 headers／secrets）；runtime 對 `remote` 型組出閘道網址與標頭。
2. 整合（web，雲端 Supabase）：用一個本機假 MCP server 當創作者端，經閘道呼叫工具 → 結果正確、創作者端收到可驗證的通行證、`mcp_usage` 多一筆；移除顧問後同一張專案通行證被拒。
3. pgTAP：`remote_mcp_targets`、`mcp_usage` 只有 `service_role` 可讀寫。
4. 真實環境：自己架——以子專案 4 的金融顧問 MCP 驗收；代管——上傳範本套件、部署、從新專案呼叫。

## 7. 部署順序

| 階段 | 內容 |
|---|---|
| 3a | migration（兩張表、範本欄位、`hire_agent` 複製）→ Vercel 環境變數（`RUNTIME_TOKEN_SECRET`、`MCP_SIGNING_KEY`）→ web → runtime → `redeploy-runtime`（`.env` 加 `PLATFORM_URL`） |
| 3b | migration（版本、代管金鑰）→ web（創作者頁面、部署流程）；runtime 不變 |
| 3c | 文件與 prompt 一行 |

實作計畫分兩份：3a＋3c 一份（子專案 4 只需要這份加上創作者自己架），3b 另一份。

Vercel 環境變數要由有 `rayzilabs-2056` 團隊權限的人設定（使用者或 Eric）。

## 8. 不在本次範圍

- 收費、分潤、用量上限。
- 代管 Sprite 的資源上限與費用。
- 從 GitHub 自動部署代管 MCP。
- 既有專案升級到新版代管 MCP 的按鈕。
- 單次工具呼叫超過 300 秒。
