import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { createHostedSpriteOps } from '@/lib/hosted-sprite';
import { readJson, route } from '@/lib/http';
import { listHostedSecretKeys, setHostedSecrets } from '@/lib/services/hosted-mcp';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

const Body = z.object({ secrets: z.record(z.string(), z.string('金鑰的值必須是文字').min(1, '金鑰的值不能是空的')) });

type Ctx = { params: Promise<{ id: string; mcp: string }> };

/** 只回傳名稱，值不再顯示 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, mcp } = await params;
  return { keys: await listHostedSecretKeys(adminDb(), user.id, id, mcp) };
});

/** 寫入後套用到執行中的版本並重啟 */
export const PUT = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, mcp } = await params;
  const { secrets } = await readJson(req, Body);
  await setHostedSecrets(adminDb(), user.id, id, mcp, secrets, createHostedSpriteOps());
  return { ok: true };
});
