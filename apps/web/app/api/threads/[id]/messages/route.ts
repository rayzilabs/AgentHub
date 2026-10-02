import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { getThreadMessages } from '@/lib/services/threads';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  return getThreadMessages(adminDb(), user.id, (await params).id);
});
