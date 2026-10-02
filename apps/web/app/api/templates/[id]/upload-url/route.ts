import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { createSkillsUploadUrl } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  return createSkillsUploadUrl(adminDb(), user.id, (await params).id);
});
