import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { listFiles } from '@/lib/services/files';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  return listFiles(adminDb(), user.id, (await params).id);
});
