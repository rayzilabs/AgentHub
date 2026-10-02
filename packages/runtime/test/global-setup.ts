import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    supabaseUrl: string;
    supabaseServiceKey: string;
  }
}

export default function setup(project: TestProject) {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  project.provide('supabaseUrl', url);
  project.provide('supabaseServiceKey', key);

  return async () => {
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    for (;;) {
      const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      const testUsers = data.users.filter((u) => u.email?.endsWith('@test.local'));
      if (testUsers.length === 0) break;
      await Promise.all(testUsers.map((u) => db.auth.admin.deleteUser(u.id)));
    }
  };
}
