import { Workspace } from '@/components/workspace/workspace';
import { orNotFound, requirePageUser } from '@/lib/page-guards';
import { getProjectDetail } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser(`/projects/${id}`);
  return <Workspace initial={await orNotFound(getProjectDetail(adminDb(), user.id, id))} />;
}
