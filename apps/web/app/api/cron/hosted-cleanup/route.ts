import { env } from '@/lib/env';
import { createHostedOps } from '@/lib/hosted-runtime';
import { HttpError, route } from '@/lib/http';
import { cleanupFailed, removeOrphanBundles } from '@/lib/services/hosted-mcp';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

/** Vercel 排程每天呼叫：刪除失敗超過 24 小時與下架後沒刪成功的代管機器（刪不掉的只記錄、不擋其他台）、範本已不存在的套件 */
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
  const { destroyed: machines, failed } = await cleanupFailed(db, createHostedOps());
  const bundles = await removeOrphanBundles(db);
  const names = machines.length ? `（${machines.join(', ')}）` : '';
  const stuck = failed.length ? `、刪不掉 ${failed.length} 台（${failed.map((f) => `${f.host} ${f.name}`).join(', ')}）` : '';
  console.log(`[cron] hosted-cleanup 完成：刪除機器 ${machines.length} 台${names}${stuck}、套件 ${bundles.length} 個`);
  return { machines, failed, bundles };
});
