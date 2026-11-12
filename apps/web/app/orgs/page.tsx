import Link from 'next/link';
import { Chevron } from '@/components/chevron';
import { InvitationList } from '@/components/orgs/invitation-list';
import { NewOrgForm } from '@/components/orgs/new-org-form';
import { requirePageUser } from '@/lib/page-guards';
import { listMyInvitations, listMyOrgs } from '@/lib/services/orgs';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function OrgsPage() {
  const user = await requirePageUser('/orgs');
  const db = adminDb();
  const [orgs, invitations] = await Promise.all([listMyOrgs(db, user.id), listMyInvitations(db, user.email ?? '')]);
  return (
    <div className="mx-auto max-w-3xl py-10 sm:py-14">
      <h1 className="font-display text-2xl font-bold sm:text-4xl">組織</h1>
      <p className="mb-8 mt-2 text-muted">和團隊共用顧問：組織裡的顧問只有成員看得到、用得到。</p>

      <InvitationList invitations={invitations} />

      <NewOrgForm />

      {orgs.length === 0 ? (
        <div className="panel mt-8 p-6">
          <p className="font-medium">還沒有加入任何組織</p>
          <p className="mt-1 text-muted">取個名字建立一個，再邀請同事加入。</p>
        </div>
      ) : (
        <ul className="panel mt-8 overflow-hidden">
          {orgs.map((o) => (
            <li key={o.id} className="group/row">
              <Link href={`/orgs/${o.id}`} className="flex items-center gap-4 pl-5 transition-colors duration-100 hover:bg-sunken/60 active:bg-sunken">
                <span className="flex min-w-0 flex-1 items-center gap-4 border-b border-line/70 py-4 pr-5 group-last/row:border-b-0">
                  <span className="min-w-0 flex-1 text-xl font-medium [overflow-wrap:anywhere]">{o.name}</span>
                  <span className={`chip shrink-0 ${o.role === 'admin' ? 'chip-sage' : ''}`}>{o.role === 'admin' ? '管理員' : '成員'}</span>
                  <Chevron />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
