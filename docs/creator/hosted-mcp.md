# 把你的 MCP 交給 AgentHub 代管

不會架伺服器也沒關係：上傳 MCP 程式，平台幫你部署、執行。租用你顧問的人與 agent 只拿得到工具回傳的結果，看不到程式、資料與你的金鑰。

自己架伺服器的做法見 [remote-mcp.md](remote-mcp.md)。

## 1. 準備套件

一個 zip（最大 50 MB），根目錄要有 `mcp.json`：

```json
{ "runtime": "python", "start": "python server.py", "install": "requirements.txt" }
```

| 欄位 | 說明 |
|---|---|
| `runtime` | `python` 或 `node` |
| `start` | 啟動指令。程式必須在 `0.0.0.0:8080` 的 `/mcp` 提供 MCP streamable HTTP |
| `install` | 可省略。Python 是 requirements 檔（裝進 `.venv`，`start` 裡的 `python` 就是它）；Node 填 `package.json`（有 lock 檔時 `npm ci`，否則 `npm install`） |

最快的做法是從範本開始，只改工具：

- Python：[examples/hosted-python](examples/hosted-python/)（mcp 2.3.0 的 `MCPServer`）
- Node：[examples/hosted-node](examples/hosted-node/)（官方 `@modelcontextprotocol/sdk`）

兩個範本都已內建平台通行證驗證，平台以外的請求一律 401。

### 平台注入的環境變數

| 名稱 | 內容 |
|---|---|
| `AGENTHUB_MCP_URL` | 這個版本對外的 MCP 網址；等於通行證的 `aud` |
| `AGENTHUB_PLATFORM_URL` | 平台網址；等於通行證的 `iss`，公鑰在 `<平台網址>/.well-known/jwks.json` |
| `PORT` | `8080` |
| 你設定的金鑰 | 見第 3 節 |

## 2. 在範本加入

範本的 MCP 項目設為 `{ "name": "fin", "transport": "remote", "hosted": true }`，不填網址。agent 看到的工具名稱是 `fin__<你的工具名>`。

## 3. 部署、發布、下架（API）

創作者頁面還在做，目前用 API（需登入，`Authorization: Bearer <你的 access token>`）。以下路徑都在 `/api/templates/<範本 id>/hosted/<MCP 名稱>` 底下。

| 動作 | 請求 | 說明 |
|---|---|---|
| 設定金鑰 | `PUT /secrets`，`{ "secrets": { "API_KEY": "..." } }` | 名稱用大寫英文、數字、底線；`PORT` 與 `AGENTHUB_` 開頭的保留名稱不能用。值只能覆寫，不會再顯示。更新後套用到所有執行中的版本並重啟 |
| 建立版本 | `POST /versions` | 回傳 `{ version, signedUrl }`，用 `PUT` 把 zip 上傳到 `signedUrl` |
| 開始部署 | `POST /versions/<版本 id>/deploy` | 狀態變成 `deploying` |
| 查看狀態 | `GET /versions/<版本 id>` | 每 5 秒查一次，部署就會往前推進。成功是 `ready` 並列出 `tools`；失敗是 `failed`，`log_tail` 是日誌最後 100 行 |
| 發布 | `POST /versions/<版本 id>/publish` | 只有 `ready` 能發布。之後新的租用都鎖定最新的已發布版本 |
| 下架 | `DELETE /versions/<版本 id>` | 還有專案在用時不能下架 |
| 版本列表 | `GET /versions` | |

範本要上架時，每個代管 MCP 都必須至少有一個已發布的版本。

**版本與既有專案**：每個版本是一台獨立的機器。已租用的專案留在租用當時的版本，發布新版本不影響它們；要讓既有專案用新版本，請租用者重新加入顧問。

## 4. 限制

| 項目 | 上限 |
|---|---|
| 每個代管 MCP | 3 個已發布版本，加 1 個部署中的版本 |
| 每位創作者 | 10 台代管機器（部署中、成功、已發布、失敗未清理的都算；失敗的 24 小時後自動清理） |
| 部署時間 | 10 分鐘 |
| 套件大小 | 50 MB |
| 單次工具呼叫 | 300 秒 |

## 5. 執行環境與費用

- 你的程式以沒有管理權限的帳號執行，可以連外（例如呼叫付費資料來源）。
- 一段時間沒有呼叫，機器會休眠，程式也會暫停；下一次呼叫時自動喚醒（第一個請求會慢幾秒）。背景工作不會在休眠期間繼續跑，排程類的工作請不要依賴它。
- 平台記錄每次工具呼叫的次數與耗時。濫用或費用異常時，平台可能停用版本，呼叫會回 503。
