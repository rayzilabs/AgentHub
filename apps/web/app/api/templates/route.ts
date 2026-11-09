import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { TemplateInputSchema } from '@/lib/schemas';
import { createTemplate, listMyTemplates, listOrgTemplates, listPublishedTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const orgId = params.get('org');
  if (orgId) {
    const user = await requireUser(req);
    return listOrgTemplates(adminDb(), user.id, orgId);
  }
  if (params.get('mine') === '1') {
    const user = await requireUser(req);
    return listMyTemplates(adminDb(), user.id);
  }
  return listPublishedTemplates(adminDb());
});

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  return createTemplate(adminDb(), user.id, await readJson(req, TemplateInputSchema));
});
