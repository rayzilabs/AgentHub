// AgentHub 代管入口：資料檔只讀套件內的 data/，/mcp 只接受平台通行證，再載入 taiwan-law-mcp 的 server.js。
// 平台注入 AGENTHUB_MCP_URL（通行證的 aud）、AGENTHUB_PLATFORM_URL（iss）與 PORT=8080。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedJwks, verifyPlatformToken } from './auth.mjs';

const audience = process.env.AGENTHUB_MCP_URL;
const issuer = (process.env.AGENTHUB_PLATFORM_URL ?? '').replace(/\/$/, '');
if (!audience || !issuer) throw new Error('缺少 AGENTHUB_MCP_URL 或 AGENTHUB_PLATFORM_URL，這個套件只能由 AgentHub 代管執行');

process.env.DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const jwks = cachedJwks(`${issuer}/.well-known/jwks.json`);
globalThis.agenthubVerify = (req) => verifyPlatformToken(req.headers['x-agenthub-token'], { audience, issuer, jwks });

await import('./server.js');
