import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { createVersion, listVersions } from '@/lib/services/hosted-mcp';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string; mcp: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, mcp } = await params;
  return listVersions(adminDb(), user.id, id, mcp);
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, mcp } = await params;
  return createVersion(adminDb(), user.id, id, mcp);
});
