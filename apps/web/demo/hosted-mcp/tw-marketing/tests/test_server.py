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


if __name__ == "__main__":
    unittest.main()
