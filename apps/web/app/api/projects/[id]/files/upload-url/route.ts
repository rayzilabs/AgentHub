import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { createFileUploadUrl } from '@/lib/services/files';
import { adminDb } from '@/lib/supabase/admin';

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const { filename } = await readJson(req, z.object({ filename: z.string().min(1, '缺少檔名') }));
  return createFileUploadUrl(adminDb(), user.id, (await params).id, filename);
});
