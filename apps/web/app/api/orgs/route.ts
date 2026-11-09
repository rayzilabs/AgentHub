import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { OrgInputSchema } from '@/lib/schemas';
import { createOrg, listMyOrgs } from '@/lib/services/orgs';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  return listMyOrgs(adminDb(), user.id);
});

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  return createOrg(adminDb(), { id: user.id, email: user.email ?? '' }, await readJson(req, OrgInputSchema));
});
