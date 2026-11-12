import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { MessageTextSchema } from '@/lib/schemas';
import { deleteQueued, editQueued } from '@/lib/services/run-control';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string; queuedId: string }> };

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, queuedId } = await params;
  const { text } = await readJson(req, z.object({ text: MessageTextSchema }));
  await editQueued(adminDb(), user.id, id, queuedId, text);
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, queuedId } = await params;
  await deleteQueued(adminDb(), user.id, id, queuedId);
});
