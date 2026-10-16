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
  const { id, ...patch } = await readJson(req, z.object({
    id: z.uuid(),
    content: z.string().trim().min(1, '記憶內容不能空白').max(5000, '記憶內容最多 5000 字').optional(),
    description: z.string().trim().min(1, '記憶說明不能空白').max(200, '記憶說明最多 200 字').optional(),
  }));
  if (patch.content === undefined && patch.description === undefined) throw new HttpError(400, '請提供要修改的內容或說明');
  await updateMemory(adminDb(), user.id, (await params).id, id, patch);
  return { ok: true };
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const memoryId = new URL(req.url).searchParams.get('id');
  if (!memoryId) throw new HttpError(400, '缺少記憶 id');
  await deleteMemory(adminDb(), user.id, (await params).id, memoryId);
  return { ok: true };
});
