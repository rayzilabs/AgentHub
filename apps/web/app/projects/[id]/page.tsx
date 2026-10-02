import { notFound, redirect } from 'next/navigation';
import { Workspace } from '@/components/workspace/workspace';
import { currentUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';
import { getProjectDetail } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=/projects/${id}`);
  const detail = await getProjectDetail(adminDb(), user.id, id).catch((e) => {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  });
  return <Workspace initial={detail} />;
}
