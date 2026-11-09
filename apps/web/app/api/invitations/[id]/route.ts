import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { MyInvitationActionSchema } from '@/lib/schemas';
import { acceptInvitation, declineInvitation } from '@/lib/services/orgs';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id } = await params;
  const { action } = await readJson(req, MyInvitationActionSchema);
  const me = { id: user.id, email: user.email ?? '' };
  if (action === 'accept') return acceptInvitation(adminDb(), me, id);
  await declineInvitation(adminDb(), me, id);
});
