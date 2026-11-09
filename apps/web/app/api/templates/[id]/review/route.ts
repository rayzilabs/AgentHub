import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { reviewTemplate } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

const Body = z.object({ action: z.enum(['approve', 'reject'], '請選擇核准或退回') });

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const { action } = await readJson(req, Body);
  return reviewTemplate(adminDb(), user.id, (await params).id, action);
});
