import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { HttpError, readJson, route } from '@/lib/http';
import { deleteMemory, listMemories, updateMemory } from '@/lib/services/threads';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return listMemories(adminDb(), user.id, (await params).id);
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const body = await readJson(req, z.object({ id: z.uuid(), content: z.string().trim().min(1, '記憶內容不能空白') }));
  await updateMemory(adminDb(), user.id, (await params).id, body.id, body.content);
  return { ok: true };
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const memoryId = new URL(req.url).searchParams.get('id');
  if (!memoryId) throw new HttpError(400, '缺少記憶 id');
  await deleteMemory(adminDb(), user.id, (await params).id, memoryId);
  return { ok: true };
});
