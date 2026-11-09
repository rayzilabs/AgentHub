import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { OrgPatchSchema } from '@/lib/schemas';
import { getOrgDetail, updateOrg } from '@/lib/services/orgs';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return getOrgDetail(adminDb(), user.id, (await params).id);
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return updateOrg(adminDb(), user.id, (await params).id, await readJson(req, OrgPatchSchema));
});
