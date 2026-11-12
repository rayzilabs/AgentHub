import { after } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { MessageTextSchema } from '@/lib/schemas';
import { addQueued } from '@/lib/services/run-control';
import { adminDb } from '@/lib/supabase/admin';

// 這輪剛好結束時，背景要等 runtime 收下下一輪（同步檔案、裝套件）
export const maxDuration = 300;

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const { text, chatPending } = await readJson(req, z.object({
    text: MessageTextSchema,
    chatPending: z.boolean().optional(),
  }));
  return addQueued(adminDb(), user.id, (await params).id, text, { chatPending, defer: after });
});
