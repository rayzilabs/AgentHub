import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Db = SupabaseClient;

export function createDb(url: string, serviceKey: string): Db {
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** runtime 帳號的通行證只用在這次 run；publishable key 是公開的，權限全看通行證 */
export function createUserDb(url: string, publishableKey: string, token: string): Db {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
