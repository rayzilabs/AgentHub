import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/threads/[id]/chat/route';
import { createProject } from '@/lib/services/projects';
import { createThread } from '@/lib/services/threads';
import { seedUser, testDb } from './helpers';

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
});
