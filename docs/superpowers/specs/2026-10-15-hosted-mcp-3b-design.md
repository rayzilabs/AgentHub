# 平台代管 MCP（子專案 3b）技術規格

- 日期：2026-10-15
- 狀態：設計待審閱
- 目標：不會架 server 的創作者，上傳 MCP 套件後由平台部署與代管。租用者與 agent 只拿到工具結果，拿不到程式、資料與創作者的金鑰。
- 前提：子專案 3a（閘道、通行證、用量）、1-C（Sprite 上沒有平台金鑰）已上線。
- 依據：`2026-10-14-remote-mcp-design.md` 第 3 節（已核准的骨架）。本文件補上當時沒定的細節，並記錄開放範圍與限制。

---

## 0. 已確認的事實

- **Fly 不會把 `Authorization` 轉給 Sprite 上的程式**（2026-10-15 在臨時 Sprite 實測）：
  - 以 `auth: 'sprite'` 建立的 Sprite，請求帶 `Authorization: Bearer <Sprites token>` 時，程式收到的標頭裡沒有 `Authorization`；`x-agenthub-token` 照常轉送。
  - 不帶 token 的請求被 Fly 擋下（401）。
  - 所以閘道可以用平台的 Sprites token 通過 Fly 驗證，創作者的程式拿不到它。
- **Vercel 函式最長 300 秒**：安裝相依套件（例如 scipy）可能超過，部署不能在 Vercel 的一次請求內做完。
- **背景程式不會讓 Sprite 一直醒著**：休眠期間程式會被暫停（第 7 節實測）。

## 1. 決策紀錄

| 項目 | 決定 |
|---|---|
| 開放對象 | 所有創作者（使用者 2026-10-14 決定） |
| 範本設定 | MCP 項目 `{ name, transport: 'remote', hosted: true }`，不填網址 |
| 一個範本多個代管 MCP | 可以；版本以「範本 + MCP 名稱」區分 |
| 語言 | Python、Node；套件內 `mcp.json` 指定 |
| 部署執行位置 | 代管 Sprite 自己（Vercel 只觸發、讀狀態） |
| 版本 | 每個版本一台 Sprite；新租用鎖定最新已發布版本；既有專案留在原版本 |
| 創作者金鑰 | Vault；只注入代管 Sprite；更新後套用到所有執行中的版本並重啟 |
| 驗證 | 閘道帶 Sprites token 通過 Fly；`X-AgentHub-Token` 帶創作者通行證，程式與自己架時共用 |

## 2. 創作者端

### 2.1 套件格式

zip，最大 50 MB，根目錄要有 `mcp.json`：

```json
{ "runtime": "python", "start": "python server.py", "install": "requirements.txt" }
```

- `runtime`：`python` 或 `node`。
- `install`：Python 是 requirements 檔；Node 是 `package.json`（執行 `npm ci`，沒有 lock 檔時 `npm install`）。可省略。
- `start`：啟動指令；程式必須在 `0.0.0.0:8080` 的 `/mcp` 提供 MCP streamable HTTP。
- 平台注入的環境變數：
  - 創作者在頁面填的金鑰
  - `PORT=8080`
  - `AGENTHUB_MCP_URL`：此版本對外網址加 `/mcp`，等於創作者通行證的 `aud`
  - `AGENTHUB_PLATFORM_URL`：通行證的 `iss`，也是公鑰網址的根
- 範本：`docs/creator/examples/hosted-python/`（FastMCP）、`docs/creator/examples/hosted-node/`（官方 SDK）。兩者都已內建通行證驗證，創作者只要寫工具。

### 2.2 頁面流程（範本編輯頁的「平台代管」區塊）

1. 範本的 MCP 選「平台代管」。
2. 填金鑰（名稱與值）。值只能覆寫，不會再顯示。
3. 上傳 zip，按「部署」，建立新版本（狀態 `deploying`）。
4. 頁面每 5 秒更新狀態，顯示部署日誌：
   - 成功（`ready`）：列出工具清單。
   - 失敗（`failed`）：顯示日誌最後 100 行。
5. 確認工具清單後按「發布這個版本」（`published`）。
6. 舊版本沒有任何專案在用時，可以「下架」（`retired`，刪除該 Sprite）。
7. 範本要上架時，每個代管 MCP 都必須至少有一個 `published` 版本。

## 3. 部署

### 3.1 資料

| 表 | 欄位 | 權限 |
|---|---|---|
| `hosted_mcp_versions` | `id`、`template_id`、`mcp_name`、`version`、`status`（`deploying`／`ready`／`failed`／`published`／`retired`／`disabled`）、`bundle_path`、`sprite_name`、`sprite_url`、`tools`、`log_tail`、`created_at`、`published_at` | 只有 service role |
| `hosted_mcp_secrets` | `template_id`、`mcp_name`、`key`、`vault_secret_id` | 只有 service role |
| `remote_mcp_targets` | 新增 `hosted_version_id`（`kind = 'hosted'` 時使用） | 不變 |

- Storage bucket `mcp-bundles`（私有）：`<template_id>/<mcp_name>/<version>.zip`。
- `hire_agent`：範本的代管 MCP 寫入 `remote_mcp_targets(kind='hosted', hosted_version_id = 該 MCP 最新的 published 版本)`；沒有 published 版本就拒絕租用。

### 3.2 流程

1. `POST /api/templates/:id/hosted/:mcp/versions`（創作者本人）：
   - 檢查限制（第 5 節）。
   - 建立版本列，回傳上傳用的簽名網址。
2. 上傳完成後 `POST …/versions/:v/deploy`。Vercel 在 `after()` 裡做以下事情，約 1 分鐘內結束：
   - 建立 Sprite `agenthub-mcp-<版本 id 前 12 碼>`（`auth: 'sprite'`）。
   - 寫入部署腳本與 `.env`（金鑰、`PORT`、`AGENTHUB_MCP_URL`、`AGENTHUB_PLATFORM_URL`；權限 600，擁有者是執行創作者程式的帳號）。
   - 以 Sprite 服務 `deploy` 啟動部署腳本後即返回。
3. 部署腳本（在 Sprite 上執行，最多 10 分鐘）：
   - 下載 zip（一次性簽名網址），解壓。
   - 讀 `mcp.json`，依 `runtime` 安裝相依套件。
   - 註冊服務 `mcp`（`start` 指令，`httpPort: 8080`）。
   - 等 `/mcp` 回應後，以 `tools/list` 取得工具清單。
   - 每一步寫進 `~/deploy/status.json`（`step`、`ok`、`tools`、`error`）與 `~/deploy/log.txt`。
4. `GET …/versions/:v`：版本還在 `deploying` 時，讀 Sprite 上的 `status.json` 與 log 尾端，把結果寫回 `hosted_mcp_versions`（`ready`／`failed`）。超過 10 分鐘還沒完成就標 `failed`（「部署逾時」）。
5. 失敗的版本保留 Sprite 24 小時方便查看日誌，之後由清理腳本刪除。

### 3.3 創作者程式的執行身分

- 代管 Sprite 上，創作者程式以非 root 帳號 `mcp` 執行（建立方式同子專案 1-A 的沙盒帳號，只是不需要多帳號隔離）。
- 程式讀不到平台寫入的部署腳本，也拿不到 Sprites API socket 的能力。
- 代管 Sprite 上沒有任何平台金鑰，只有這個 MCP 的創作者金鑰。

## 4. 呼叫

- 閘道 `resolveRemoteTarget`：`kind = 'hosted'` 時查 `hosted_mcp_versions`：
  - `status` 是 `published`／`ready`（已被租用的舊版本）→ 轉送到 `sprite_url + /mcp`。
  - `disabled` → 503「這個工具服務已被暫停」。
  - `retired` → 404。
- 轉送標頭：
  - `Authorization: Bearer <Sprites token>`：Fly 驗證後拿掉。
  - `X-AgentHub-Token: <創作者通行證>`：`aud = sprite_url + /mcp`。
- Sprite 休眠時第一個請求需要喚醒。閘道對 502／503 重試兩次（間隔 1 秒）。
- 用量照 3a 記在 `mcp_usage`。

## 5. 限制

| 項目 | 上限 |
|---|---|
| 每個代管 MCP 同時保留的版本 | 3 個 `published` + 1 個 `deploying`。要建新版本時，已發布的超過 3 個，就要先下架沒人使用的舊版本 |
| 每位創作者的代管 Sprite | 10 台（`deploying`、`ready`、`published`、`failed` 未清理的都算） |
| 部署時間 | 10 分鐘 |
| 套件大小 | 50 MB |
| 營運者停用 | `apps/web/scripts/hosted-mcp.ts disable <version_id>`：停掉服務、狀態改 `disabled`，閘道回 503 |

## 6. 錯誤處理

| 情境 | 處理 |
|---|---|
| `mcp.json` 缺少或格式錯 | 部署失敗，日誌寫明原因 |
| 安裝失敗 | 部署失敗，日誌顯示安裝輸出最後 100 行 |
| 程式起不來或 `/mcp` 不回應 | 部署失敗，日誌顯示程式輸出 |
| `tools/list` 回空清單 | 部署失敗（「沒有任何工具」） |
| 超過限制 | 建立版本時回 409，訊息說明是哪一項 |
| 代管 Sprite 喚醒失敗 | 閘道回 502，用量記 `ok = false`（同 3a） |
| 範本有代管 MCP 但沒有已發布版本 | 上架回 400；租用回 409 |

## 7. 背景程式與費用

2026-10-15 在臨時 Sprite 上實測：服務是一個持續佔滿 CPU 的忙迴圈，之後不再對 Sprite 發任何請求。

- **狀態**：約 30 秒後轉為 `cold`（休眠）。之後 12 分鐘大多是 `cold`，每 1.5～2 分鐘短暫 `warm` 約 30 秒，又回到 `cold`。
- **CPU 時間**：閒置 5 分鐘後喚醒量測，經過 306 秒，程式只用了 59 秒 CPU。休眠期間程式被暫停，不是在背景繼續跑。

結論：
- 背景程式無法讓 Sprite 一直醒著，挖礦一類的濫用沒辦法持續進行。
- 費用大致跟「被呼叫的次數與時間」成正比。
- 暫時不需要「每日運行時間上限」。

之後以 `mcp_usage`（每個版本的呼叫次數與耗時）和 Fly 帳單觀察；有異常再用第 5 節的停用指令處理。

## 8. 測試

1. 單元：
   - `mcp.json` 檢查
   - 限制計算
   - 狀態轉換
   - `resolveRemoteTarget` 對 `hosted` 的各種狀態
   - schema 的 `hosted: true`
2. 整合（雲端 DB）：
   - 建立版本 → 發布 → 租用 → `remote_mcp_targets` 鎖定版本。
   - 發布新版本後，舊專案仍指向舊版本。
   - `disabled` 回 503。
3. 真實 Sprite（驗收腳本，用完刪除）：
   - Python 與 Node 範本各部署一次：工具清單正確，經閘道呼叫成功。
   - 程式讀不到部署腳本。
   - `Authorization` 不會到達程式。
   - 金鑰更新後重啟生效。
4. 正式環境：用範本上架一個測試顧問，從新專案呼叫，查 `mcp_usage`，最後刪除。

## 9. 上線順序

1. migration（兩張新表、`remote_mcp_targets.hosted_version_id`、`hire_agent`、bucket）：使用者在 Dashboard 執行。
2. web（頁面、API、部署流程、閘道）：push `main`。
3. runtime 不變。

## 10. 不在本次範圍

- 收費與分潤、用量上限（`mcp_usage` 已有資料，之後可加）。
- 從 GitHub 自動部署。
- 既有專案一鍵升級到新版本。
- 代管 MCP 的對外網路限制（創作者程式可以連外，例如呼叫付費資料源）。
