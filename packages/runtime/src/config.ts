import { z } from 'zod';

const EnvSchema = z.object({
  PROJECT_ID: z.uuid(),
  SUPABASE_URL: z.url(),
  /** 公開金鑰；資料庫權限全看 Vercel 每次轉送對話時附上的 runtime 帳號通行證 */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  AGENTS_ROOT: z.string().default('/agents'),
  SHARED_ROOT: z.string().default('/shared'),
  SPRITE_API_SOCK: z.string().default('/.sprite/api.sock'),
  MODEL_ID: z.string().default('gemini-3.6-flash'),
  PORT: z.coerce.number().int().default(8080),
  /** 沙盒帳號；Sprite 上一律是 agent，本機開發不設定 */
  SANDBOX_USER: z.string().min(1).optional(),
  /** 平台網址；模型與 remote 型 MCP 都經這裡的閘道呼叫 */
  PLATFORM_URL: z.url(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}
