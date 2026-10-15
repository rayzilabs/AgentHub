import { env } from '@/lib/env';
import { createHostedSpriteOps } from '@/lib/hosted-sprite';
import { HttpError, route } from '@/lib/http';
import { cleanupFailed, removeOrphanBundles } from '@/lib/services/hosted-mcp';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

/** Vercel 排程每天呼叫：刪除失敗超過 24 小時與下架後沒刪成功的代管 Sprite、範本已不存在的套件 */
export const GET = route(async (req: Request) => {
  const secret = env.cronSecret;
  if (!secret) throw new HttpError(503, '未設定 CRON_SECRET');
  if (req.headers.get('authorization') !== `Bearer ${secret}`) throw new HttpError(401, '未授權');
  const db = adminDb();
  const sprites = await cleanupFailed(db, createHostedSpriteOps());
  const bundles = await removeOrphanBundles(db);
  return { sprites, bundles };
});
