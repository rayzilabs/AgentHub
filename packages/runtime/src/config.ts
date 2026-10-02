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
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}
