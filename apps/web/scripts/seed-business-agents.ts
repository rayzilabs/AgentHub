import { fileURLToPath } from 'node:url';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

const { adminDb } = await import('../lib/supabase/admin');
const { BUSINESS_AGENTS_ROOT, loadDemoAgents, publishDemoAgents } = await import('../lib/demo');

// 非金融顧問只上架到市集，不建專案、不租用；用既有的 Demo 創作者帳號，不動它的密碼
const CREATOR = 'creator@demo.agenthub.app';
const db = adminDb();

const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) throw error;
const creator = data.users.find((u) => u.email === CREATOR);
if (!creator) {
  console.error(`找不到 Demo 創作者帳號 ${CREATOR}。請先執行 scripts/seed-demo.ts 建立 Demo 帳號，再重跑這支腳本。`);
  process.exit(1);
}

for (const p of await publishDemoAgents(db, creator.id, await loadDemoAgents(BUSINESS_AGENTS_ROOT))) console.log(`${p.created ? '已建立' : '已更新'}並上架：${p.name}`);
