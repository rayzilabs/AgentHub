import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

// .in() 的 id 放在網址裡，一次太多會超過長度限制
function chunks(ids: string[], size = 100): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

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
      // 測試帳號建立的組織不會隨帳號刪除（created_by 變成 null），先記下來；
      // 組織的範本與副本隨帳號刪掉之後才刪得掉（on delete restrict）
      const orgIds: string[] = [];
      for (const ids of chunks(testUsers.map((u) => u.id))) {
        const { data: orgs, error: orgError } = await db.from('organizations').select('id').in('created_by', ids);
        if (orgError) throw orgError;
        orgIds.push(...orgs.map((o) => o.id as string));
      }
      // 逐一刪除：這裡的測試帳號常上百個，同時送出會有連線失敗（fetch failed）
      for (const u of testUsers) {
        const { error: deleteError } = await db.auth.admin.deleteUser(u.id);
        if (deleteError) throw deleteError;
      }
      for (const ids of chunks(orgIds)) {
        const { error: orgError } = await db.from('organizations').delete().in('id', ids);
        if (orgError) throw orgError;
      }
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
