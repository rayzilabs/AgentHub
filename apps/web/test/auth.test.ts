import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { currentUser, requireUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';
import { seedUser, testDb } from './helpers';

const db = testDb();

describe('Bearer 驗證', () => {
  it('有效的 access token 取得使用者；無效的 token 視為未登入', async () => {
    const user = await seedUser(db);
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false },
    });
    const { data, error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
    expect(error).toBeNull();
    const token = data.session!.access_token;

    const ok = await currentUser(new Request('http://x', { headers: { authorization: `Bearer ${token}` } }));
    expect(ok?.id).toBe(user.id);

    const bad = new Request('http://x', { headers: { authorization: 'Bearer not-a-token' } });
    expect(await currentUser(bad)).toBeNull();
    await expect(requireUser(bad)).rejects.toBeInstanceOf(HttpError);
  });
});
