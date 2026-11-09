import { notFound, redirect } from 'next/navigation';
import { TemplateEditor } from '@/components/template-editor';
import { currentUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';
import { listMyOrgs } from '@/lib/services/orgs';
import { getEditableTemplate } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function EditTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=/creator/${id}`);
  const template = await getEditableTemplate(adminDb(), user.id, id).catch((e) => {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  });
  const orgName = template.org_id
    ? (await listMyOrgs(adminDb(), user.id)).find((o) => o.id === template.org_id)?.name ?? null
    : null;
  return (
    <div className="mx-auto max-w-3xl py-10">
      <TemplateEditor initial={template} orgName={orgName} />
    </div>
  );
}
