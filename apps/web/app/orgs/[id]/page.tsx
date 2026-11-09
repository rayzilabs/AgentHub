import { notFound, redirect } from 'next/navigation';
import { InviteForm } from '@/components/orgs/invite-form';
import { MemberList } from '@/components/orgs/member-list';
import { OrgSettings } from '@/components/orgs/org-settings';
import { OrgTemplates } from '@/components/orgs/org-templates';
import { currentUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';
import { getOrgDetail } from '@/lib/services/orgs';
import { listOrgTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function OrgPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=/orgs/${id}`);
  const db = adminDb();
  const detail = await getOrgDetail(db, user.id, id).catch((e) => {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  });
  const templates = await listOrgTemplates(db, user.id, id);
  const { org, role, members, invitations } = detail;
  const isAdmin = role === 'admin';
  return (
    <div className="mx-auto max-w-3xl space-y-10 py-10 sm:py-14">
      <header>
        <h1 className="font-display text-2xl font-bold [overflow-wrap:anywhere] sm:text-4xl">{org.name}</h1>
        <p className="mt-2 text-muted">你是{isAdmin ? '管理員' : '成員'}。{org.require_template_approval && '成員放上的顧問要管理員核准才會上架。'}</p>
      </header>

      <section>
        <h2 className="group-title">組織的顧問</h2>
        <OrgTemplates orgId={id} isAdmin={isAdmin} templates={templates} />
      </section>

      <section>
        <h2 className="group-title">成員</h2>
        <MemberList orgId={id} userId={user.id} role={role} members={members} />
      </section>

      <section>
        <h2 className="group-title">邀請</h2>
        <InviteForm orgId={id} isAdmin={isAdmin} invitations={invitations} />
      </section>

      {isAdmin && (
        <section>
          <h2 className="group-title">設定</h2>
          <OrgSettings org={org} />
        </section>
      )}
    </div>
  );
}
