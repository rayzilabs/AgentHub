'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { MyInvitation } from '@/lib/services/orgs';
import { dateText, useAction } from './use-action';

/** 我收到的邀請。第一次載入時的清單留在畫面上（重新整理資料後伺服器端會少掉處理過的那筆），讓結果訊息不消失。 */
export function InvitationList({ invitations }: { invitations: MyInvitation[] }) {
  const [initial] = useState(invitations);
  if (initial.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="group-title">待處理的邀請</h2>
      <ul className="panel divide-y divide-line/70 overflow-hidden">
        {initial.map((inv) => <InvitationItem key={inv.id} inv={inv} />)}
      </ul>
    </section>
  );
}

function InvitationItem({ inv }: { inv: MyInvitation }) {
  const router = useRouter();
  const { run, busy, error } = useAction();
  const [result, setResult] = useState<string | null>(null);
  function respond(action: 'accept' | 'decline') {
    void run<{ joined?: boolean }>(`/api/invitations/${inv.id}`, { method: 'POST', body: { action } }, (r) => {
      if (action === 'accept' && r.joined) router.push(`/orgs/${inv.org_id}`);
      else {
        setResult(action === 'decline' ? '已婉拒' : '已送出，等管理員核准');
        router.refresh();
      }
    });
  }
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-lg font-medium [overflow-wrap:anywhere]">{inv.org_name}</p>
        <p className="hint mt-0">{inv.invited_by_email || '某位成員'} 邀請你，{dateText(inv.expires_at)} 前有效</p>
        {error && <p role="alert" className="notice notice-error mt-2">{error}</p>}
      </div>
      {result ? <span className="chip chip-sage">{result}</span> : (
        <div className="flex gap-2">
          <button disabled={busy} onClick={() => respond('accept')} className="btn btn-primary btn-sm">接受</button>
          <button disabled={busy} onClick={() => respond('decline')} className="btn btn-secondary btn-sm">婉拒</button>
        </div>
      )}
    </li>
  );
}
