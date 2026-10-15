// AgentHub 平台代管 MCP 範本（Node）：在 buildServer 裡加你的工具，其餘不用改。
//
// 平台注入的環境變數：
// - AGENTHUB_MCP_URL：這個版本對外的 MCP 網址，等於平台通行證的 aud
// - AGENTHUB_PLATFORM_URL：平台網址，等於通行證的 iss；公鑰在 <平台網址>/.well-known/jwks.json
// - PORT：固定 8080
// - 你在頁面上設定的金鑰
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

const MCP_URL = process.env.AGENTHUB_MCP_URL;
const PLATFORM_URL = process.env.AGENTHUB_PLATFORM_URL.replace(/\/$/, '');
const jwks = createRemoteJWKSet(new URL(`${PLATFORM_URL}/.well-known/jwks.json`), { cacheMaxAge: 300_000 });

function buildServer(headerNames) {
  const server = new McpServer({ name: 'example', version: '1.0.0' });
  server.registerTool(
    'echo',
    {
      description: '回傳收到的文字。env_name：回報這個環境變數是否存在（不回傳值）；show_headers：列出這次請求收到的標頭名稱。',
      inputSchema: { text: z.string(), env_name: z.string().optional(), show_headers: z.boolean().optional() },
    },
    async ({ text, env_name, show_headers }) => {
      const out = { text };
      if (env_name) out.env_present = env_name in process.env;
      if (show_headers) out.headers = headerNames;
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  );
  return server;
}

/** 只接受平台簽發的通行證（X-AgentHub-Token，ES256）。平台以外的請求一律 401。 */
async function verify(req) {
  const token = req.headers['x-agenthub-token'];
  if (!token) throw Object.assign(new Error('缺少平台通行證'), { status: 401 });
  try {
    await jwtVerify(token, jwks, { algorithms: ['ES256'], audience: MCP_URL, issuer: PLATFORM_URL, clockTolerance: 30 });
  } catch (e) {
    // 取不到公鑰是平台端的問題，不是通行證的問題
    const unavailable = e.code === 'ERR_JWKS_TIMEOUT' || e.code === 'ERR_JOSE_GENERIC' || e.name === 'TypeError';
    throw Object.assign(new Error(unavailable ? `取不到平台公鑰：${e.message}` : `通行證無效：${e.message}`), { status: unavailable ? 503 : 401 });
  }
}

const reply = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

createServer(async (req, res) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/mcp') return reply(res, 404, { error: 'not found' });
  try {
    await verify(req);
  } catch (e) {
    return reply(res, e.status, { error: e.message });
  }
  // 無狀態：每個請求一個 server 與 transport
  const server = buildServer(Object.keys(req.headers).sort());
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) reply(res, 500, { error: '伺服器錯誤' });
  }
}).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
