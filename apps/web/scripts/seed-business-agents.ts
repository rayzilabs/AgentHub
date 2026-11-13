import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

const { adminDb } = await import('../lib/supabase/admin');
const { env } = await import('../lib/env');
const { apiHostedClient, BUSINESS_AGENTS_ROOT, loadDemoAgents, publishDemoAgents } = await import('../lib/demo');
const { findUserIdByEmail } = await import('../lib/runtime-session');

// 非金融顧問只上架到市集，不建專案、不租用；用既有的 Demo 創作者帳號，不動它的密碼
const CREATOR = 'creator@demo.agenthub.app';
const db = adminDb();

const creatorId = await findUserIdByEmail(db, CREATOR);
if (!creatorId) {
  console.error(`找不到 Demo 創作者帳號 ${CREATOR}。請先執行 scripts/seed-demo.ts 建立 Demo 帳號，再重跑這支腳本。`);
  process.exit(1);
}

// 代管 MCP 的部署由正式站推進（部署檢查要用只在正式站的平台私鑰）。
// 以 admin 產生一次性登入連結、在這裡兌換成 session，取得創作者的 access token；不寄信、不改密碼
const { data: link, error: linkError } = await db.auth.admin.generateLink({ type: 'magiclink', email: CREATOR });
if (linkError) throw linkError;
const anon = createClient(env.supabaseUrl, env.supabasePublishableKey, { auth: { persistSession: false } });
const { data: session, error: otpError } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
if (otpError || !session.session) throw otpError ?? new Error('取不到創作者的登入 session');
const hosted = apiHostedClient(env.platformUrl, session.session.access_token);
console.log(`代管 MCP 由 ${env.platformUrl} 部署`);

for (const p of await publishDemoAgents(db, creatorId, await loadDemoAgents(BUSINESS_AGENTS_ROOT), hosted)) {
  const deployed = p.deployed.length ? `；部署新版代管 MCP：${p.deployed.join('、')}` : '';
  console.log(`${p.created ? '已建立' : '已更新'}並上架：${p.name}${deployed}`);
}
await anon.auth.signOut({ scope: 'local' });
