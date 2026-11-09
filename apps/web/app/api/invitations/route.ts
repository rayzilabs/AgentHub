import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { listMyInvitations } from '@/lib/services/orgs';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  return listMyInvitations(adminDb(), user.email ?? '');
});
