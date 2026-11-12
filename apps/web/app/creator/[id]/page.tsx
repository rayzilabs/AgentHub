import { TemplateEditor } from '@/components/template-editor';
import { orNotFound, requirePageUser } from '@/lib/page-guards';
import { listMyOrgs } from '@/lib/services/orgs';
import { getEditableTemplate } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function EditTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser(`/creator/${id}`);
  const template = await orNotFound(getEditableTemplate(adminDb(), user.id, id));
  const orgName = template.org_id
    ? (await listMyOrgs(adminDb(), user.id)).find((o) => o.id === template.org_id)?.name ?? null
    : null;
  return (
    <div className="mx-auto max-w-3xl py-10">
      <TemplateEditor initial={template} orgName={orgName} />
    </div>
  );
}
