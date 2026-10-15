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
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    // Vercel 的 Runtime Logs 只列出有輸出的請求；印出原因（不印密鑰）才查得到排程有沒有帶對
    console.warn(`[cron] hosted-cleanup 拒絕：${auth ? '密鑰不符' : '沒有帶密鑰'}`);
    throw new HttpError(401, '未授權');
  }
  const db = adminDb();
  const sprites = await cleanupFailed(db, createHostedSpriteOps());
  const bundles = await removeOrphanBundles(db);
  const names = sprites.length ? `（${sprites.join(', ')}）` : '';
  console.log(`[cron] hosted-cleanup 完成：刪除 Sprite ${sprites.length} 台${names}、套件 ${bundles.length} 個`);
  return { sprites, bundles };
});
