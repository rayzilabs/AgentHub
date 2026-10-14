import { env } from '@/lib/env';
import { route } from '@/lib/http';
import { publicJwk } from '@/lib/platform-tokens';

/** 創作者用這組公鑰驗證平台簽發的通行證；輪換期間新舊並列 */
export const GET = route(async () => {
  const keys = [env.mcpSigningKey, env.mcpSigningKeyPrevious].filter((k): k is string => !!k).map(publicJwk);
  return Response.json({ keys }, { headers: { 'cache-control': 'public, max-age=300' } });
});
