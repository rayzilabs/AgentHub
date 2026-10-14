import { z } from 'zod';

const EnvSchema = z.object({
  PROJECT_ID: z.uuid(),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  VERTEX_API_EXPRESS_MODE_KEY: z.string().min(1),
  AGENTS_ROOT: z.string().default('/agents'),
  SHARED_ROOT: z.string().default('/shared'),
  SPRITE_API_SOCK: z.string().default('/.sprite/api.sock'),
  MODEL_ID: z.string().default('gemini-3.8-flash'),
  PORT: z.coerce.number().int().default(8080),
  /** 沙盒帳號；Sprite 上一律是 agent，本機開發不設定 */
  SANDBOX_USER: z.string().min(1).optional(),
  /** 平台網址；remote 型 MCP 經這裡的閘道呼叫 */
  PLATFORM_URL: z.url().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}
