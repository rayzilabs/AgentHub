import { route } from '@/lib/http';
import { bearerToken, requireProjectToken } from '@/lib/platform-tokens';
import { extendForKeepalive } from '@/lib/services/run-control';
import { adminDb } from '@/lib/supabase/admin';

/** E2B 的逾時不看流量：runtime 對話中定期呼叫，驗證專案通行證後由平台延長沙盒 */
export const POST = route(async (req: Request) => {
  const projectId = requireProjectToken(bearerToken(req));
  return extendForKeepalive(adminDb(), projectId);
});
