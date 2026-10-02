import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { listProjects } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  return listProjects(adminDb(), user.id);
});
