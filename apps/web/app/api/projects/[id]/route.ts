import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { getProjectDetail } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return getProjectDetail(adminDb(), user.id, (await params).id);
});
