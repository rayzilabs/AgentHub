import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { InviteSchema } from '@/lib/schemas';
import { invite } from '@/lib/services/orgs';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { email } = await readJson(req, InviteSchema);
  return invite(adminDb(), user.id, (await params).id, email);
});
