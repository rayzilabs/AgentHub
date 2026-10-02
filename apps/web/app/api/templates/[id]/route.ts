import { currentUser, requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { TemplatePatchSchema } from '@/lib/schemas';
import { getTemplate, updateTemplate } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await currentUser(req);
  return getTemplate(adminDb(), (await params).id, user?.id ?? null);
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return updateTemplate(adminDb(), user.id, (await params).id, await readJson(req, TemplatePatchSchema));
});
