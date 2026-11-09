'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { OrgMember, OrgRole } from '@/lib/services/orgs';
import { useAction } from './use-action';

export function MemberList({ orgId, userId, role, members }: { orgId: string; userId: string; role: OrgRole; members: OrgMember[] }) {
  const router = useRouter();
  const { run, busy, error } = useAction();
  const [confirming, setConfirming] = useState<string | null>(null);
  const isAdmin = role === 'admin';
  const base = `/api/orgs/${orgId}/members`;

  function remove(m: OrgMember) {
    const self = m.user_id === userId;
    void run(`${base}/${m.user_id}`, { method: 'DELETE' }, () => {
      if (self) router.push('/orgs');
      else { setConfirming(null); router.refresh(); }
    });
  }
  function setRole(m: OrgMember, next: OrgRole) {
    void run(`${base}/${m.user_id}`, { method: 'PATCH', body: { role: next } });
  }

  return (
    <div>
      <ul className="panel divide-y divide-line/70 overflow-hidden">
        {members.map((m) => {
          const self = m.user_id === userId;
          return (
            <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{m.email}{self && <span className="text-muted">（你）</span>}</span>
              <span className={`chip ${m.role === 'admin' ? 'chip-sage' : ''}`}>{m.role === 'admin' ? '管理員' : '成員'}</span>
              <div className="flex flex-wrap gap-2">
                {isAdmin && !self && (
                  <button disabled={busy} onClick={() => setRole(m, m.role === 'admin' ? 'member' : 'admin')} className="btn btn-plain btn-sm">
                    {m.role === 'admin' ? '設為成員' : '設為管理員'}
                  </button>
                )}
                {confirming === m.user_id ? (
                  <>
                    <button disabled={busy} onClick={() => remove(m)} className="btn btn-primary btn-sm">{self ? '確定退出' : '確定移出'}</button>
                    <button disabled={busy} onClick={() => setConfirming(null)} className="btn btn-plain btn-sm">取消</button>
                  </>
                ) : (isAdmin || self) && (
                  <button disabled={busy} onClick={() => setConfirming(m.user_id)} className="btn btn-plain btn-sm">{self ? '退出組織' : '移出'}</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="notice notice-error mt-2">{error}</p>}
    </div>
  );
}
