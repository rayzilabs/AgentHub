import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { createFolder, entryName } from '@/lib/services/files';
import { adminDb } from '@/lib/supabase/admin';

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const input = await readJson(req, z.object({ name: entryName, parentId: z.string().uuid().nullable() }));
  return createFolder(adminDb(), user.id, (await params).id, input);
});
