import { after } from 'next/server';
import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { getOwnProject, setSpriteState } from '@/lib/services/projects';
import { provisionProject } from '@/lib/sprites';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const project = await getOwnProject(adminDb(), user.id, (await params).id);
  await setSpriteState(adminDb(), project.id, { sprite_status: 'provisioning', sprite_error: null });
  after(() => provisionProject(adminDb(), project.id));
  return { ok: true };
});
