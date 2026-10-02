import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

export type Db = SupabaseClient;

let cached: Db | undefined;

export function adminDb(): Db {
  cached ??= createClient(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
