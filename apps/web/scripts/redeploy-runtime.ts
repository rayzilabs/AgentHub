import { fileURLToPath } from 'node:url';
import { SpritesClient } from '@fly/sprites';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

const { adminDb } = await import('@/lib/supabase/admin');
const { installRuntime, spriteName } = await import('@/lib/sprites');

const db = adminDb();
const client = new SpritesClient(process.env.FLY_SPRITES_TOKEN!);
const { data: projects, error } = await db.from('projects').select('id, sprite_name').eq('sprite_status', 'ready');
if (error) throw error;

for (const p of projects) {
  const sprite = client.sprite(p.sprite_name ?? spriteName(p.id));
  await installRuntime(db, sprite, p.id);
  const logs = await sprite.restartService('runtime');
  await logs.processAll(() => {});
  console.log(`已更新 ${p.id}`);
}
