import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { deleteOwnProject, getOwnProject, getProjectDetail } from '@/lib/services/projects';
import { destroyProjectSprite, spriteName } from '@/lib/sprites';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return getProjectDetail(adminDb(), user.id, (await params).id);
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const db = adminDb();
  const project = await getOwnProject(db, user.id, (await params).id);
  // 先刪 Sprite：失敗時專案還在，使用者可以再按一次刪除重試
  await destroyProjectSprite(project.sprite_name ?? spriteName(project.id));
  await deleteOwnProject(db, user.id, project.id);
  return { ok: true };
});
