import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { getVersion, publishVersion } from '@/lib/services/hosted-mcp';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string; mcp: string; versionId: string }> };

export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, mcp, versionId } = await params;
  const db = adminDb();
  await getVersion(db, user.id, id, mcp, versionId);
  return publishVersion(db, user.id, versionId);
});
