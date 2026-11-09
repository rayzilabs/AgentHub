import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { InvitationActionSchema } from '@/lib/schemas';
import { approveInvitation, rejectInvitation, revokeInvitation } from '@/lib/services/orgs';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string; invitationId: string }> };

export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, invitationId } = await params;
  const { action } = await readJson(req, InvitationActionSchema);
  if (action === 'approve') return approveInvitation(adminDb(), user.id, id, invitationId);
  await rejectInvitation(adminDb(), user.id, id, invitationId);
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, invitationId } = await params;
  await revokeInvitation(adminDb(), user.id, id, invitationId);
});
