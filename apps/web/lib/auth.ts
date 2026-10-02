import type { User } from '@supabase/supabase-js';
import { HttpError } from '@/lib/http';
import { adminDb } from '@/lib/supabase/admin';
import { createSessionClient } from '@/lib/supabase/server';

export async function currentUser(req?: Request): Promise<User | null> {
  const token = req?.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (token) {
    const { data, error } = await adminDb().auth.getUser(token);
    return error ? null : data.user;
  }
  const supabase = await createSessionClient();
  const { data } = await supabase.auth.getUser();
  return data.user;
}

export async function requireUser(req?: Request): Promise<User> {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, '請先登入');
  return user;
}
