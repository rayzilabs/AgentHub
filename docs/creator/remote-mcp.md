# 把你的 MCP 接上 AgentHub（自己架）

你的腳本與資料留在你自己的伺服器上。租用你顧問的人與 agent 只拿得到工具回傳的結果，看不到程式、資料與網址。

## 1. 準備 MCP server

- 使用 MCP **streamable HTTP**（例如 Python 的 FastMCP、Node 的 `@modelcontextprotocol/sdk`）。
- 網址必須是 `https://`。
- 單次工具呼叫最長 300 秒，超過會被平台切斷。

## 2. 在範本加入

創作者頁面 →「工具（MCP）」→ 新增工具：

- 名稱：英數字、`-`、`_`，例如 `fin`。agent 看到的工具名稱是 `fin__<你的工具名>`。
- 連線方式：**你自己架的 MCP（經平台閘道）**。
- 網址：你的 MCP 端點，例如 `https://mcp.example.com/mcp`。

這種連線方式不能設定標頭或金鑰，身分改由平台通行證證明（見下一節）。

租用時，平台會鎖定當時的網址。之後你改了範本，已租用的專案仍連原本的網址；要換網址，請保持舊網址可用，或請租用者重新加入顧問。

## 3. 驗證平台通行證

每次呼叫，平台都在標頭 `X-AgentHub-Token` 附上一張 ES256 JWT，`Authorization: Bearer` 也是同一張。

| 欄位 | 內容 |
|---|---|
| `iss` | `https://agenthub-kappa-pink.vercel.app` |
| `aud` | 你在範本填的網址（完全相同的字串） |
| `sub` | 顧問 id（每次租用一個） |
| `project_id` | 專案 id |
| `template_id` | 你的範本 id |
| `exp` | 5 分鐘後過期 |
| `jti` | 每次呼叫不同 |

公鑰在 `https://agenthub-kappa-pink.vercel.app/.well-known/jwks.json`，以 `kid` 選用。平台換金鑰時，新舊公鑰會並列一段時間，所以請依 `kid` 取用，不要寫死。

**不驗證的 MCP 仍可運作，但等於任何知道網址的人都能呼叫。**

Python（PyJWT）：

```python
import jwt

PLATFORM = "https://agenthub-kappa-pink.vercel.app"
MY_URL = "https://mcp.example.com/mcp"
jwks = jwt.PyJWKClient(f"{PLATFORM}/.well-known/jwks.json")

def verify(token: str) -> dict:
    key = jwks.get_signing_key_from_jwt(token)
    return jwt.decode(token, key.key, algorithms=["ES256"], audience=MY_URL, issuer=PLATFORM)
```

Node（jose）：

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const PLATFORM = 'https://agenthub-kappa-pink.vercel.app';
const MY_URL = 'https://mcp.example.com/mcp';
const jwks = createRemoteJWKSet(new URL(`${PLATFORM}/.well-known/jwks.json`));

export async function verify(token: string) {
  const { payload } = await jwtVerify(token, jwks, { algorithms: ['ES256'], issuer: PLATFORM, audience: MY_URL });
  return payload; // payload.sub、payload.project_id 可用來分租用者計量或限流
}
```

驗證失敗時回 HTTP 401。

## 4. 大量資料

不要把大量資料直接放進工具結果，以免占滿 agent 的上下文。請改回傳短期有效的下載連結：

```json
{ "download_url": "https://storage.example.com/signed/...", "expires_in": 600 }
```

- 連結由你自己的儲存空間簽發（例如 S3、GCS、Supabase Storage 的 signed URL），建議 10 分鐘內過期。
- agent 會在自己的沙盒用 `curl` 下載後再計算。
- 平台不代理下載。

## 5. 用量

每次 `tools/call` 平台都會記錄：時間、專案、顧問、工具名稱、成功與否、耗時。目前只記錄，不收費。
