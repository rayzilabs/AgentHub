import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { addQueued } from '@/lib/services/run-control';
import { adminDb } from '@/lib/supabase/admin';

// 這輪剛好結束時要等 runtime 收下下一輪（同步檔案、裝套件）
export const maxDuration = 300;

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const { text } = await readJson(req, z.object({ text: z.string().trim().min(1, '請輸入訊息') }));
  return addQueued(adminDb(), user.id, (await params).id, text);
});
