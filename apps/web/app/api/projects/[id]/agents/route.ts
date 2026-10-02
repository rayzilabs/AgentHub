import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { hireAgent } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

const Body = z.object({
  template_id: z.uuid('請選擇要加入的 agent'),
  secrets: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const body = await readJson(req, Body);
  const instanceId = await hireAgent(adminDb(), user.id, (await params).id, body.template_id, body.secrets);
  return { id: instanceId };
});
