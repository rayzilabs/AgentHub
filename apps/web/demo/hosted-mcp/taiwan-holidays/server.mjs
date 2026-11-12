// AgentHub 平台代管的 taiwan-holidays MCP。計算核心來自上游 imsyuan/taiwan-holidays（MIT），
// 這個檔只負責平台通行證驗證與 HTTP 傳輸（照 docs/creator/examples/hosted-node/server.mjs）。
import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createServer } from './src/create-server.ts';

const MCP_URL = process.env.AGENTHUB_MCP_URL;
const PLATFORM_URL = process.env.AGENTHUB_PLATFORM_URL.replace(/\/$/, '');
const jwks = createRemoteJWKSet(new URL(`${PLATFORM_URL}/.well-known/jwks.json`), { cacheMaxAge: 300_000 });

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

createHttpServer(async (req, res) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/mcp') return reply(res, 404, { error: 'not found' });
  try {
    await verify(req);
  } catch (e) {
    return reply(res, e.status, { error: e.message });
  }
  // 無狀態：每個請求一個 server 與 transport
  const server = createServer();
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
