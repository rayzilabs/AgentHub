import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// 組織端到端驗證：admin 建組織 → helper 經 admin 邀請加入 → helper 邀 member、member 接受、admin 核准
// → member 建組織範本並上架 → 局外人看不到 → member 建專案、租用、對話 → admin 移出 member 後對話回 409
// → admin 重新邀請、member 接受 → 對話恢復。結束時刪掉專案（含 Sprite）、範本、組織與測試帳號。
// 用法：BASE_URL=https://… pnpm exec tsx scripts/e2e-orgs.ts（預設正式站）
process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const BASE = process.env.BASE_URL ?? 'https://agenthub-kappa-pink.vercel.app';
const url = process.env.SUPABASE_URL!;
const db = createClient(url, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });

const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail = '') => {
  results.push({ check, pass, detail: detail.slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}${pass || !detail ? '' : `\n      ${detail.slice(0, 300)}`}`);
};

type Part = { type: string; text?: string };
type Message = { role: string; parts: Part[] };
type User = { id: string; email: string; headers: Record<string, string> };

const userIds: string[] = [];
async function makeUser(label: string): Promise<User> {
  const email = `e2e-org-${label}-${randomUUID()}@test.local`;
  const password = `e2e-${randomUUID()}`;
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  userIds.push(data.user.id);
  const anon = createClient(url, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, email, headers: { authorization: `Bearer ${session.session!.access_token}`, 'content-type': 'application/json' } };
}

const raw = (u: User, path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...u.headers, ...(init.headers ?? {}) } });
const call = async <T>(u: User, path: string, init: RequestInit = {}): Promise<T> => {
  const res = await raw(u, path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body as T;
};
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Invitation = { id: string; email: string; status: 'invited' | 'accepted' };

let orgId: string | undefined;
let templateId: string | undefined;
let projectId: string | undefined;
let memberUser: User | undefined;
try {
  console.log(`組織 e2e 目標：${BASE}`);
  const admin = await makeUser('admin');
  const helper = await makeUser('helper');
  const member = await makeUser('member');
  const outsider = await makeUser('outsider');
  memberUser = member;

  // ---- 1. 建組織、邀請、核准 ----
  const org = await call<{ id: string }>(admin, '/api/orgs', post({ name: `e2e 組織 ${randomUUID().slice(0, 8)}` }));
  orgId = org.id;
  record('admin 建立組織', !!orgId);

  // admin 邀請 helper：接受後直接加入
  await call(admin, `/api/orgs/${orgId}/invitations`, post({ email: helper.email }));
  const helperInv = (await call<{ id: string }[]>(helper, '/api/invitations'))[0];
  const helperJoin = await call<{ joined: boolean }>(helper, `/api/invitations/${helperInv?.id}`, post({ action: 'accept' }));
  record('admin 邀請的人接受後直接加入', helperJoin.joined === true, JSON.stringify(helperJoin));

  // 一般成員邀請：接受後要等 admin 核准
  await call(helper, `/api/orgs/${orgId}/invitations`, post({ email: member.email }));
  const memberInv = (await call<{ id: string }[]>(member, '/api/invitations'))[0];
  const accepted = await call<{ joined: boolean }>(member, `/api/invitations/${memberInv?.id}`, post({ action: 'accept' }));
  const pending = (await call<{ invitations: Invitation[] }>(admin, `/api/orgs/${orgId}`)).invitations.find((i) => i.email === member.email);
  record('成員邀請的人接受後等核准（還不是成員）', accepted.joined === false && pending?.status === 'accepted', JSON.stringify({ accepted, pending }));
  await call(admin, `/api/orgs/${orgId}/invitations/${pending!.id}`, post({ action: 'approve' }));
  const afterApprove = await call<{ members: { user_id: string }[] }>(admin, `/api/orgs/${orgId}`);
  record('admin 核准後 member 成為成員', afterApprove.members.some((m) => m.user_id === member.id));

  // ---- 2. 組織範本 ----
  const tpl = await call<{ id: string }>(member, '/api/templates', post({
    name: '組織顧問 e2e', description: '組織 e2e 用，只有 system prompt', system_prompt: '你是組織內部顧問。回覆一句簡短的繁體中文問候。', org_id: orgId,
  }));
  templateId = tpl.id;
  await call(member, `/api/templates/${templateId}/publish`, { method: 'POST' });
  record('member 建立組織範本並上架', true);

  const outsiderGet = await raw(outsider, `/api/templates/${templateId}`);
  const publicList = await call<{ id: string }[]>(outsider, '/api/templates');
  record('局外人 GET 範本是 404', outsiderGet.status === 404, String(outsiderGet.status));
  record('公開市集列表不含組織範本', Array.isArray(publicList) && !publicList.some((t) => t.id === templateId));

  // ---- 3. member 建專案、租用、對話 ----
  const project = await call<{ id: string }>(member, '/api/projects', post({ name: '組織 e2e' }));
  projectId = project.id;
  const start = Date.now();
  for (let i = 0; ; i++) {
    const d = await call<{ project: { sprite_status: string; sprite_error: string | null } }>(member, `/api/projects/${projectId}`);
    if (d.project.sprite_status === 'ready') break;
    if (d.project.sprite_status === 'error') throw new Error(`環境準備失敗：${d.project.sprite_error}`);
    if (i > 100) throw new Error('環境準備逾時');
    await sleep(3000);
  }
  console.log(`環境就緒（${Math.round((Date.now() - start) / 1000)} 秒）`);
  await call(member, `/api/projects/${projectId}/agents`, post({ template_id: templateId }));
  const thread = await call<{ id: string }>(member, `/api/projects/${projectId}/threads`, post({}));

  const chat = async (text: string) => {
    const res = await raw(member, `/api/threads/${thread.id}/chat`, post({ text }));
    if (!res.ok) return { status: res.status, body: await res.text().catch(() => '') };
    await res.text();
    for (let i = 0; ; i++) {
      const m = await call<{ messages: Message[]; running: boolean; error: string | null }>(member, `/api/threads/${thread.id}/messages`);
      if (!m.running) {
        const last = [...m.messages].reverse().find((x) => x.role === 'assistant');
        return { status: res.status, error: m.error, reply: (last?.parts ?? []).map((p) => p.text ?? '').join('').trim() };
      }
      if (i > 300) throw new Error('等待回覆逾時');
      await sleep(3000);
    }
  };

  const first = await chat('你好，請簡短打個招呼。');
  record('成員在組織內：送訊息得到非空回覆', first.status === 200 && 'reply' in first && !!first.reply && !first.error, JSON.stringify(first));

  // ---- 4. 移出 → 409 ----
  const removeRes = await raw(admin, `/api/orgs/${orgId}/members/${member.id}`, { method: 'DELETE' });
  record('admin 移出 member', removeRes.ok, String(removeRes.status));
  const blocked = await chat('還在嗎？');
  record('移出後送訊息得到 409「專案裡的顧問都已無法使用」',
    blocked.status === 409 && 'body' in blocked && !!blocked.body?.includes('專案裡的顧問都已無法使用'), JSON.stringify(blocked));

  // ---- 5. 重新邀請（admin 邀請直接加入）→ 恢復 ----
  await call(admin, `/api/orgs/${orgId}/invitations`, post({ email: member.email }));
  const reInv = (await call<{ id: string }[]>(member, '/api/invitations'))[0];
  const rejoin = await call<{ joined: boolean }>(member, `/api/invitations/${reInv?.id}`, post({ action: 'accept' }));
  record('admin 重新邀請、member 接受後回到組織', rejoin.joined === true, JSON.stringify(rejoin));
  const again = await chat('歡迎回來，請再打個招呼。');
  record('重新加入後送訊息成功', again.status === 200 && 'reply' in again && !!again.reply && !again.error, JSON.stringify(again));
} finally {
  // 中途失敗時照樣清乾淨：刪專案會先刪 Sprite；刪不掉就印出來，避免刪掉使用者後找不到它
  if (projectId && memberUser) {
    const res = await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: memberUser.headers }).catch((e: unknown) => e);
    if (!(res instanceof Response && res.ok)) console.error(`⚠ 刪除專案失敗，請手動刪除 Sprite agenthub-${projectId}`);
  }
  if (templateId) {
    const { error } = await db.from('agent_templates').delete().eq('id', templateId);
    if (error) console.error(`⚠ 刪除範本 ${templateId} 失敗：${error.message}`);
  }
  if (orgId) {
    const { error } = await db.from('organizations').delete().eq('id', orgId);
    if (error) console.error(`⚠ 刪除組織 ${orgId} 失敗：${error.message}`);
  }
  for (const id of userIds) {
    const { error } = await db.auth.admin.deleteUser(id);
    if (error) console.error(`⚠ 刪除測試使用者 ${id} 失敗：${error.message}`);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
if (failed.length) process.exit(1);
