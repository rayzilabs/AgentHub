import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

const { adminDb } = await import('../lib/supabase/admin');
const { loadDemoAgents } = await import('../lib/demo');
const templates = await import('../lib/services/templates');
const projects = await import('../lib/services/projects');
const { provisionProject } = await import('../lib/sprites');

const db = adminDb();
const DEMO_PROJECT = '金融科技展 Demo';

async function ensureUser(email: string, password: string): Promise<string> {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const found = data.users.find((u) => u.email === email);
  if (found) {
    const { error: updateError } = await db.auth.admin.updateUserById(found.id, { password });
    if (updateError) throw updateError;
    return found.id;
  }
  const { data: created, error: createError } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (createError) throw createError;
  return created.user.id;
}

const generated = !process.env.DEMO_PASSWORD;
if (!generated && process.env.DEMO_PASSWORD!.length < 12) {
  console.error('DEMO_PASSWORD 至少要 12 個字元。');
  process.exit(1);
}
if (generated) {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  if (data.users.some((u) => u.email?.endsWith('@demo.agenthub.app'))) {
    console.error('Demo 帳號已存在，但沒有設定 DEMO_PASSWORD。為避免重設既有密碼，已中止；請設定 DEMO_PASSWORD（至少 12 個字元）後再執行。');
    process.exit(1);
  }
}
const password = process.env.DEMO_PASSWORD ?? randomBytes(9).toString('base64url');
const creatorId = await ensureUser('creator@demo.agenthub.app', password);
const demoUserId = await ensureUser('demo@demo.agenthub.app', password);

const existing = await templates.listMyTemplates(db, creatorId);
const templateIds: string[] = [];
for (const agent of await loadDemoAgents()) {
  const current = existing.find((t) => t.name === agent.input.name);
  const t = current ?? (await templates.createTemplate(db, creatorId, agent.input));
  const { signedUrl } = await templates.createSkillsUploadUrl(db, creatorId, t.id);
  const put = await fetch(signedUrl, { method: 'PUT', body: new Blob([new Uint8Array(agent.skillsZip)], { type: 'application/zip' }), headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
  if (!put.ok) throw new Error(`上傳 ${agent.slug} skill 失敗：${put.status}`);
  await templates.updateTemplate(db, creatorId, t.id, { ...agent.input, process_upload: true });
  await templates.publishTemplate(db, creatorId, t.id);
  templateIds.push(t.id);
  console.log(`${current ? '已更新' : '已建立'}並上架：${agent.input.name}`);
}

let project = (await projects.listProjects(db, demoUserId)).find((p) => p.name === DEMO_PROJECT);
if (!project) {
  project = await projects.createProject(db, demoUserId, DEMO_PROJECT);
  console.log('已建立 Demo 專案');
}
const detail = await projects.getProjectDetail(db, demoUserId, project.id);
for (const id of templateIds) {
  if (!detail.agents.some((a) => a.template_id === id)) await projects.hireAgent(db, demoUserId, project.id, id, {});
}
if (project.sprite_status !== 'ready') {
  console.log('正在準備 Demo 專案的 agent 環境…');
  await provisionProject(db, project.id);
}
const final = await projects.getOwnProject(db, demoUserId, project.id);
console.log(`Demo 專案狀態：${final.sprite_status}${final.sprite_error ? `（${final.sprite_error}）` : ''}`);
console.log('Demo 帳號：creator@demo.agenthub.app、demo@demo.agenthub.app');
if (generated) console.log(`Demo 密碼（只顯示這一次）：${password}`);
