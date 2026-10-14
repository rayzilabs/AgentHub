import { env } from '@/lib/env';
import { route } from '@/lib/http';
import { publicJwk } from '@/lib/platform-tokens';

/** 創作者用這組公鑰驗證平台簽發的通行證 */
export const GET = route(async () => ({ keys: [publicJwk(env.mcpSigningKey)] }));
