import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { deleteOwnProject, getProjectDetail } from '@/lib/services/projects';
import { destroyProjectSprite, spriteName } from '@/lib/sprites';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return getProjectDetail(adminDb(), user.id, (await params).id);
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const project = await deleteOwnProject(adminDb(), user.id, (await params).id);
  await destroyProjectSprite(project.sprite_name ?? spriteName(project.id));
  return { ok: true };
});
