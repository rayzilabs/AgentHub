import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { stopThreadRun } from '@/lib/services/run-control';
import { adminDb } from '@/lib/supabase/admin';

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  await stopThreadRun(adminDb(), user.id, (await params).id);
});
