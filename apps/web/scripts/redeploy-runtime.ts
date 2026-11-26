import { fileURLToPath } from 'node:url';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

const { adminDb } = await import('@/lib/supabase/admin');
const { hostFor, projectMachine } = await import('@/lib/hosts');
const { installRuntime } = await import('@/lib/project-runtime');

const db = adminDb();
const { data: projects, error } = await db.from('projects').select('id, host, sprite_name, sprite_url, host_token').eq('sprite_status', 'ready');
if (error) throw error;

const failed: string[] = [];
for (const p of projects) {
  try {
    const m = projectMachine(p);
    if (!m) throw new Error('專案沒有機器名稱或網址');
    // installRuntime 會重新啟動 runtime 服務，載入新的 main.js
    await installRuntime(db, hostFor(m.host), m, p.id);
    console.log(`已更新 ${p.id}`);
  } catch (e) {
    failed.push(p.id);
    console.error(`更新失敗 ${p.id}：`, e instanceof Error ? e.message : e);
  }
}

if (failed.length > 0) {
  console.error(`${failed.length} 個專案更新失敗：${failed.join(', ')}`);
  process.exit(1);
}
