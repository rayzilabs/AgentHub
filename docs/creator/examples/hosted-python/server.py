"""AgentHub 平台代管 MCP 範本（Python）：在下面加你的工具，其餘不用改。

平台注入的環境變數：
- AGENTHUB_MCP_URL：這個版本對外的 MCP 網址，等於平台通行證的 aud
- AGENTHUB_PLATFORM_URL：平台網址，等於通行證的 iss；公鑰在 <平台網址>/.well-known/jwks.json
- PORT：固定 8080
- 你在頁面上設定的金鑰
"""
import contextvars
import os

import anyio
import jwt
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse

MCP_URL = os.environ["AGENTHUB_MCP_URL"]
PLATFORM_URL = os.environ["AGENTHUB_PLATFORM_URL"].rstrip("/")
_jwks = jwt.PyJWKClient(f"{PLATFORM_URL}/.well-known/jwks.json", cache_keys=True, lifespan=300)
_header_names = contextvars.ContextVar("header_names", default=[])

server = MCPServer("example", instructions="平台代管 MCP 範本")


@server.tool()
def echo(text: str, env_name: str | None = None, show_headers: bool = False) -> dict:
    """回傳收到的文字。env_name：回報這個環境變數是否存在（不回傳值）；show_headers：列出這次請求收到的標頭名稱。"""
    out = {"text": text}
    if env_name:
        out["env_present"] = env_name in os.environ
    if show_headers:
        out["headers"] = _header_names.get()
    return out


class PlatformAuth:
    """只接受平台簽發的通行證（X-AgentHub-Token，ES256）。平台以外的請求一律 401。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
            token = headers.get("x-agenthub-token")
            try:
                await anyio.to_thread.run_sync(verify, token)
            except jwt.PyJWKClientConnectionError as e:
                return await JSONResponse({"error": f"取不到平台公鑰：{e}"}, status_code=503)(scope, receive, send)
            except (jwt.InvalidTokenError, jwt.PyJWKClientError) as e:
                return await JSONResponse({"error": f"通行證無效：{e}"}, status_code=401)(scope, receive, send)
            _header_names.set(sorted(headers))
        await self.app(scope, receive, send)


def verify(token):
    if not token:
        raise jwt.InvalidTokenError("缺少平台通行證")
    key = _jwks.get_signing_key_from_jwt(token).key
    return jwt.decode(token, key, algorithms=["ES256"], audience=MCP_URL, issuer=PLATFORM_URL, leeway=30,
                      options={"require": ["exp", "iss", "aud", "sub"]})


# 平台的 Sprite 網址不固定，來源由通行證把關，不做 Host 檢查
app = PlatformAuth(server.streamable_http_app(
    streamable_http_path="/mcp", stateless_http=True, json_response=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False)))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
