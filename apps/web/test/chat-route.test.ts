import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/threads/[id]/chat/route';
import * as sprites from '@/lib/sprites';
import { createProject, hireAgent } from '@/lib/services/projects';
import { createTemplate, publishTemplate } from '@/lib/services/templates';
import { createThread } from '@/lib/services/threads';
import { seedUser, testDb } from './helpers';

vi.mock('@/lib/sprites', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sprites')>()),
  forwardChat: vi.fn(async () => new Response('ok')),
}));

const db = testDb();

describe('轉送對話', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('平台沒設定 RUNTIME_TOKEN_SECRET 時直接回 503（模型代理需要專案通行證，不轉送注定失敗的對話）', async () => {
    vi.stubEnv('RUNTIME_TOKEN_SECRET', '');
    const user = await seedUser(db);
    const p = await createProject(db, user.id, 'p');
    await db.from('projects').update({ sprite_status: 'ready', sprite_url: 'http://127.0.0.1:9' }).eq('id', p.id);
    const t = await createThread(db, user.id, p.id);
    const auth = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { data } = await auth.auth.signInWithPassword({ email: user.email, password: user.password });
    const res = await POST(
      new Request(`https://p.test/api/threads/${t.id}/chat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${data.session!.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      }),
      { params: Promise.resolve({ id: t.id }) },
    );
    expect(res.status).toBe(503);
  });

  it('顧問都無法使用時不轉送', async () => {
    vi.stubEnv('RUNTIME_TOKEN_SECRET', 'test-secret-for-chat-route-at-least-32-chars');
    const user = await seedUser(db);
    const { data: org, error } = await db.from('organizations').insert({ name: '實驗室', created_by: user.id }).select('id').single();
    if (error) throw error;
    await db.from('org_members').insert({ org_id: org.id, user_id: user.id, role: 'admin', email: user.email });
    const tpl = await createTemplate(db, user.id, { name: '組織顧問', description: '', category: '', system_prompt: '你是顧問', mcp_servers: [] });
    await publishTemplate(db, user.id, tpl.id);
    await db.from('agent_templates').update({ org_id: org.id }).eq('id', tpl.id);
    const p = await createProject(db, user.id, 'p');
    await hireAgent(db, user.id, p.id, tpl.id, {});
    await db.from('org_members').delete().eq('org_id', org.id).eq('user_id', user.id);
    await db.from('projects').update({ sprite_status: 'ready', sprite_url: 'http://127.0.0.1:9' }).eq('id', p.id);
    const t = await createThread(db, user.id, p.id);
    const auth = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { data } = await auth.auth.signInWithPassword({ email: user.email, password: user.password });
    vi.mocked(sprites.forwardChat).mockClear();
    const res = await POST(
      new Request(`https://p.test/api/threads/${t.id}/chat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${data.session!.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      }),
      { params: Promise.resolve({ id: t.id }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('專案裡的顧問都已無法使用');
    expect(sprites.forwardChat).not.toHaveBeenCalled();
  });
});
