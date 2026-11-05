import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { deleteQueued, editQueued } from '@/lib/services/run-control';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string; queuedId: string }> };

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, queuedId } = await params;
  const { text } = await readJson(req, z.object({ text: z.string().trim().min(1, '請輸入訊息') }));
  await editQueued(adminDb(), user.id, id, queuedId, text);
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, queuedId } = await params;
  await deleteQueued(adminDb(), user.id, id, queuedId);
});
