import { notFound, redirect } from 'next/navigation';
import { TemplateEditor } from '@/components/template-editor';
import { currentUser } from '@/lib/auth';
import { listMyTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function EditTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=/creator/${id}`);
  const template = (await listMyTemplates(adminDb(), user.id)).find((t) => t.id === id);
  if (!template) notFound();
  return (
    <div className="mx-auto max-w-3xl py-10">
      <TemplateEditor initial={template} />
    </div>
  );
}
