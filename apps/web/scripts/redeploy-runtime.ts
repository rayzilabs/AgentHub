import { fileURLToPath } from 'node:url';
import { SpritesClient } from '@fly/sprites';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

const { adminDb } = await import('@/lib/supabase/admin');
const { installRuntime, spriteName } = await import('@/lib/sprites');

const db = adminDb();
const client = new SpritesClient(process.env.FLY_SPRITES_TOKEN!);
const { data: projects, error } = await db.from('projects').select('id, sprite_name').eq('sprite_status', 'ready');
if (error) throw error;

const failed: string[] = [];
for (const p of projects) {
  try {
    const sprite = client.sprite(p.sprite_name ?? spriteName(p.id));
    // installRuntime 會重新啟動 runtime 服務，載入新的 main.js
    await installRuntime(db, sprite, p.id);
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
