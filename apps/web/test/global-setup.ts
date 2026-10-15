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
    // 測試範本隨使用者刪除後，Storage 裡的代管 MCP 套件不會跟著刪
    const { removeOrphanBundles } = await import('@/lib/services/hosted-mcp');
    await removeOrphanBundles(db as never);
    // 測試專案隨使用者刪除後，留下的 runtime 帳號也要清掉（與 lib/runtime-session 的清理相同）
    const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const runtimeUsers = (data?.users ?? []).filter((u) => typeof u.app_metadata?.agenthub_runtime_project === 'string');
    if (runtimeUsers.length > 0) {
      const { data: alive } = await db.from('projects').select('id')
        .in('id', runtimeUsers.map((u) => u.app_metadata.agenthub_runtime_project as string));
      const aliveIds = new Set((alive ?? []).map((p) => p.id as string));
      await Promise.all(runtimeUsers
        .filter((u) => !aliveIds.has(u.app_metadata.agenthub_runtime_project as string))
        .map((u) => db.auth.admin.deleteUser(u.id)));
    }
  };
}
