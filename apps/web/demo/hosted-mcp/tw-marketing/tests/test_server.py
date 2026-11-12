"""server 的工具層測試：可預期的錯誤要讓模型看到中文說明（ToolError），不是「Error executing tool」。
執行：在 tw-marketing 目錄 `python -m unittest discover -s tests`（需要 requirements.txt 的套件）"""
import asyncio
import os
import unittest

os.environ.setdefault("AGENTHUB_MCP_URL", "http://127.0.0.1:8080/mcp")
os.environ.setdefault("AGENTHUB_PLATFORM_URL", "http://127.0.0.1:1")

from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError  # noqa: E402

import server  # noqa: E402


def call(name, args):
    return asyncio.run(server.server.call_tool(name, args))


class ToolErrors(unittest.TestCase):
    def test_bad_calendar_input_returns_readable_message(self):
        with self.assertRaises(ToolError) as cm:
            call("tw_calendar", {"start": "2027/1/1", "end": "2027-02-01"})
        self.assertNotIsInstance(cm.exception, UnexpectedToolError)
        self.assertIn("YYYY-MM-DD", str(cm.exception))


class PlatformToken(unittest.TestCase):
    """只有平台簽發的通行證（ES256、iss＝平台網址、aud＝這個版本的 MCP 網址、未過期）能呼叫。"""

    @classmethod
    def setUpClass(cls):
        import time

        import jwt
        from cryptography.hazmat.primitives.asymmetric import ec
        from starlette.testclient import TestClient

        cls.jwt, cls.time = jwt, time
        cls.key = ec.generate_private_key(ec.SECP256R1())
        public = cls.key.public_key()
        cls.orig_jwks = server._jwks
        # 換掉從平台抓 JWKS 的用戶端，改用測試自己產生的公鑰
        server._jwks = type("FakeJwks", (), {"get_signing_key_from_jwt": lambda self, t: type("K", (), {"key": public})()})()
        cls.client = TestClient(server.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        server._jwks = cls.orig_jwks

    def token(self, **override):
        claims = {"iss": server.PLATFORM_URL, "aud": server.MCP_URL, "sub": "project-1", "exp": int(self.time.time()) + 300}
        claims.update(override)
        return self.jwt.encode(claims, self.key, algorithm="ES256", headers={"kid": "test"})

    def post(self, token=None):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if token:
            headers["X-AgentHub-Token"] = token
        body = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
        return self.client.post("/mcp", json=body, headers=headers)

    def test_valid_token_can_call(self):
        res = self.post(self.token())
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["result"]["serverInfo"]["name"], "tw-marketing")

    def test_missing_token_is_rejected(self):
        self.assertEqual(self.post().status_code, 401)

    def test_expired_token_is_rejected(self):
        self.assertEqual(self.post(self.token(exp=int(self.time.time()) - 3600)).status_code, 401)

    def test_wrong_issuer_is_rejected(self):
        self.assertEqual(self.post(self.token(iss="https://evil.example")).status_code, 401)

    def test_token_for_another_sprite_is_rejected(self):
        self.assertEqual(self.post(self.token(aud="https://agenthub-mcp-other.sprites.app/mcp")).status_code, 401)


if __name__ == "__main__":
    unittest.main()
