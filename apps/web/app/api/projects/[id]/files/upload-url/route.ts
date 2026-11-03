import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { createUploadUrl } from '@/lib/services/files';
import { adminDb } from '@/lib/supabase/admin';

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  return createUploadUrl(adminDb(), user.id, (await params).id);
});
