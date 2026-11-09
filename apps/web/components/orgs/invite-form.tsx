'use client';

import { useState } from 'react';
import type { OrgInvitation } from '@/lib/services/orgs';
import { dateText, useAction } from './use-action';

export function InviteForm({ orgId, isAdmin, invitations }: { orgId: string; isAdmin: boolean; invitations: OrgInvitation[] }) {
  const { run, busy, error } = useAction();
  const [email, setEmail] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (await run(`/api/orgs/${orgId}/invitations`, { method: 'POST', body: { email } })) setEmail('');
  }
  const base = `/api/orgs/${orgId}/invitations`;
  const act = (id: string, action: 'approve' | 'reject') => run(`${base}/${id}`, { method: 'POST', body: { action } });
  const revoke = (id: string) => run(`${base}/${id}`, { method: 'DELETE' });
  const waiting = invitations.filter((i) => i.status === 'invited' && !i.expired);
  const approving = invitations.filter((i) => i.status === 'accepted');
  const expired = invitations.filter((i) => i.expired);
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
        <label className="min-w-0 flex-1 basis-64">
          <span className="sr-only">受邀者 email</span>
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="對方註冊用的 email" className="field mt-0 rounded-full px-5" />
        </label>
        <button disabled={busy} className="btn btn-primary min-h-12">{busy ? '送出中…' : '邀請'}</button>
      </form>
      {error && <p role="alert" className="notice notice-error">{error}</p>}

      {approving.length > 0 && (
        <Group title="等核准">
          {approving.map((i) => (
            <Row key={i.id} inv={i}>
              {isAdmin ? (
                <>
                  <button disabled={busy} onClick={() => act(i.id, 'approve')} className="btn btn-primary btn-sm">核准</button>
                  <button disabled={busy} onClick={() => act(i.id, 'reject')} className="btn btn-secondary btn-sm">拒絕</button>
                </>
              ) : <span className="chip">等管理員核准</span>}
            </Row>
          ))}
        </Group>
      )}
      {waiting.length > 0 && (
        <Group title="等對方接受">
          {waiting.map((i) => (
            <Row key={i.id} inv={i} note={`${dateText(i.expires_at)} 前有效`}>
              <button disabled={busy} onClick={() => revoke(i.id)} className="btn btn-plain btn-sm">撤回</button>
            </Row>
          ))}
        </Group>
      )}
      {expired.length > 0 && (
        <Group title="已過期">
          {expired.map((i) => (
            <Row key={i.id} inv={i} note="已過期">
              <button disabled={busy} onClick={() => revoke(i.id)} className="btn btn-plain btn-sm">刪除</button>
            </Row>
          ))}
        </Group>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="group-title">{title}</h3>
      <ul className="panel divide-y divide-line/70 overflow-hidden">{children}</ul>
    </section>
  );
}

function Row({ inv, note, children }: { inv: OrgInvitation; note?: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="[overflow-wrap:anywhere]">{inv.email}</p>
        <p className="hint mt-0">{inv.invited_by_email && `${inv.invited_by_email} 邀請`}{note && `　${note}`}</p>
      </div>
      <div className="flex gap-2">{children}</div>
    </li>
  );
}
