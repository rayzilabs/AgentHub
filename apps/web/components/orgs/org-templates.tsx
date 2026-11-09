'use client';

import Link from 'next/link';
import type { PublicTemplate } from '@/lib/services/templates';
import { NewTemplateButton } from '../new-template-button';
import { useAction } from './use-action';

const STATUS = { draft: '草稿', pending: '待核准', published: '已上架' } as const;

export function OrgTemplates({ orgId, isAdmin, templates }: { orgId: string; isAdmin: boolean; templates: (PublicTemplate & { editable: boolean })[] }) {
  const { run, busy, error } = useAction();
  const review = (id: string, action: 'approve' | 'reject') => run(`/api/templates/${id}/review`, { method: 'POST', body: { action } });
  return (
    <div className="space-y-4">
      <NewTemplateButton orgId={orgId} />
      {error && <p role="alert" className="notice notice-error">{error}</p>}
      {templates.length === 0 ? (
        <div className="panel p-5"><p className="text-muted">這個組織還沒有顧問。</p></div>
      ) : (
        <ul className="panel divide-y divide-line/70 overflow-hidden">
          {templates.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <div className="min-w-0 flex-1">
                <Link href={`/templates/${t.id}`} className="link text-lg font-medium [overflow-wrap:anywhere]">{t.name}</Link>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                  <span className={`chip ${t.status === 'published' ? 'chip-sage' : ''}`}>{STATUS[t.status]}</span>
                  <span>{t.creator_name || '匿名'}</span>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {isAdmin && t.status === 'pending' && (
                  <>
                    <button disabled={busy} onClick={() => review(t.id, 'approve')} className="btn btn-primary btn-sm">核准上架</button>
                    <button disabled={busy} onClick={() => review(t.id, 'reject')} className="btn btn-secondary btn-sm">退回</button>
                  </>
                )}
                {t.editable && <Link href={`/creator/${t.id}`} className="btn btn-plain btn-sm">編輯</Link>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
