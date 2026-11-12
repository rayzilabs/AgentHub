import type { User } from '@supabase/supabase-js';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';

/** 頁面用：未登入就導去登入，登入後回到 next */
export async function requirePageUser(next: string): Promise<User> {
  const user = await currentUser();
  if (!user) redirect(`/login?next=${next}`);
  return user;
}

/** 頁面用：service 丟 404 時顯示 Next 的找不到頁面 */
export function orNotFound<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  });
}
