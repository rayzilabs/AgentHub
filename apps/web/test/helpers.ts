import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { Db } from '@/lib/supabase/admin';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

export function testDb(): Db {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function seedUser(db: Db): Promise<{ id: string; email: string; password: string }> {
  const email = `u-${randomUUID()}@test.local`;
  const password = 'password-123';
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return { id: data.user.id, email, password };
}
