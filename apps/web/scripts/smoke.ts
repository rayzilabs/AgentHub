import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { strToU8, zipSync } from 'fflate';

// 用 Bearer token 走完整條 API 流程：建立顧問 → 建立專案（Sprite）→ 開對話 → 多顧問討論。
// 用法：BASE_URL=https://… pnpm exec tsx scripts/smoke.ts（預設 http://localhost:3000）
process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });

const email = `smoke-${randomUUID()}@test.local`;
const password = 'smoke-password-123';
const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (createError) throw createError;
const userId = created.user.id;

let projectId: string | undefined;
try {
  const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  const auth = { authorization: `Bearer ${session.session!.access_token}`, 'content-type': 'application/json' };

  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
    return body as T;
  };

  try {
    console.log(`冒煙測試目標：${BASE}`);
    console.log('1. 建立並上架兩位顧問');
    const templateIds: string[] = [];
    for (const [name, prompt] of [
      ['法務顧問', '你是台灣執業律師，回答要指出法律風險，簡短。'],
      ['財務顧問', '你是會計師，回答要指出財務影響，簡短。'],
    ]) {
      const t = await call<{ id: string }>('/api/templates', {
        method: 'POST',
        body: JSON.stringify({ name, description: `${name}（冒煙測試）`, system_prompt: prompt }),
      });
      const { signedUrl } = await call<{ signedUrl: string }>(`/api/templates/${t.id}/upload-url`, { method: 'POST' });
      const zip = zipSync({ 'check/SKILL.md': strToU8(`---\nname: check\ndescription: ${name}的檢查清單\n---\n\n1. 先確認事實\n`) });
      const put = await fetch(signedUrl, { method: 'PUT', body: zip, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
      if (!put.ok) throw new Error(`上傳 skill 失敗 ${put.status}`);
      await call(`/api/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ process_upload: true }) });
      await call(`/api/templates/${t.id}/publish`, { method: 'POST' });
      templateIds.push(t.id);
    }

    console.log('2. 建立專案並等待 agent 環境');
    const project = await call<{ id: string }>('/api/projects', { method: 'POST', body: JSON.stringify({ name: '冒煙測試' }) });
    projectId = project.id;
    const provisionStart = Date.now();
    for (let i = 0; ; i++) {
      const d = await call<{ project: { sprite_status: string; sprite_error: string | null } }>(`/api/projects/${project.id}`);
      if (d.project.sprite_status === 'ready') break;
      if (d.project.sprite_status === 'error') throw new Error(`環境準備失敗：${d.project.sprite_error}`);
      if (i > 100) throw new Error('環境準備逾時');
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log(`   環境就緒（${Math.round((Date.now() - provisionStart) / 1000)} 秒）`);

    console.log('3. 加入兩位顧問、開對話');
    for (const id of templateIds) {
      await call(`/api/projects/${project.id}/agents`, { method: 'POST', body: JSON.stringify({ template_id: id }) });
    }
    const thread = await call<{ id: string }>(`/api/projects/${project.id}/threads`, { method: 'POST', body: JSON.stringify({}) });

    console.log('4. 送出需要討論的問題（串流）');
    const res = await fetch(`${BASE}/api/threads/${thread.id}/chat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: '請法務和財務一起討論：把客戶交易資料拿去訓練內部模型可行嗎？最後給我總結。' }),
    });
    if (!res.ok) throw new Error(`chat → ${res.status} ${await res.text()}`);
    const streamText = await res.text();
    console.log(`   串流 ${streamText.length} 字元，含討論：${streamText.includes('convene_discussion')}`);

    console.log('5. 等待完成並檢查結果');
    for (let i = 0; ; i++) {
      const m = await call<{ messages: { role: string; parts: { type: string; text?: string }[] }[]; running: boolean; error: string | null }>(
        `/api/threads/${thread.id}/messages`,
      );
      if (!m.running) {
        if (m.error) throw new Error(`回覆失敗：${m.error}`);
        const final = m.messages.at(-1);
        if (!final || final.role !== 'assistant') throw new Error('對話沒有 agent 的回覆');
        const text = final.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
        console.log(`   共 ${m.messages.length} 則訊息；最終回覆前 300 字：\n${text.slice(0, 300)}`);
        for (const h of ['各面向建議', '共識方案', '仍有分歧']) if (!text.includes(h)) console.warn(`   ⚠ 總結缺少「${h}」`);
        break;
      }
      if (i > 200) throw new Error('等待回覆逾時');
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log('冒煙測試通過');
  } finally {
    // 刪專案會先刪 Sprite；失敗時印出 Sprite 名稱，避免刪掉使用者後找不到它
    if (projectId) {
      const res = await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: auth }).catch((e: unknown) => e);
      if (res instanceof Response && res.ok) console.log('已刪除冒煙測試專案與 Sprite');
      else console.error(`⚠ 刪除專案失敗，請手動刪除 Sprite agenthub-${projectId}：${res instanceof Response ? res.status : String(res)}`);
    }
  }
} finally {
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) console.error(`⚠ 刪除測試使用者 ${email} 失敗：${error.message}`);
}
