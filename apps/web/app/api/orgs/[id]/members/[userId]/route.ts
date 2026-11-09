import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { MemberPatchSchema } from '@/lib/schemas';
import { removeMember, setMemberRole } from '@/lib/services/orgs';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string; userId: string }> };

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, userId } = await params;
  const { role } = await readJson(req, MemberPatchSchema);
  return setMemberRole(adminDb(), user.id, id, userId, role);
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, userId } = await params;
  await removeMember(adminDb(), user.id, id, userId);
});
