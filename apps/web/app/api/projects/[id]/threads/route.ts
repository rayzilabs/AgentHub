import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { createThread, listThreads } from '@/lib/services/threads';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return listThreads(adminDb(), user.id, (await params).id);
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { title } = await readJson(req, z.object({ title: z.string().trim().max(60).optional() }));
  return createThread(adminDb(), user.id, (await params).id, title || undefined);
});
