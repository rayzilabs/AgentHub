import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Db = SupabaseClient;

export function createDb(url: string, serviceKey: string): Db {
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
