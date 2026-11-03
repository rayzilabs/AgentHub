import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { completeUpload, entryName, getProjectTree } from '@/lib/services/files';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return getProjectTree(adminDb(), user.id, (await params).id);
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const input = await readJson(req, z.object({ fileId: z.string().uuid(), folderId: z.string().uuid().nullable(), name: entryName }));
  return completeUpload(adminDb(), user.id, (await params).id, input);
});
