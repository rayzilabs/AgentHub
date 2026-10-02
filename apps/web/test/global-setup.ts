import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

export default function setup() {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  return async () => {
    const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (;;) {
      const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      const testUsers = data.users.filter((u) => u.email?.endsWith('@test.local'));
      if (testUsers.length === 0) break;
      const results = await Promise.all(testUsers.map((u) => db.auth.admin.deleteUser(u.id)));
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
    }
  };
}
