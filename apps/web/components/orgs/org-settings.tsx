'use client';

import { useState } from 'react';
import type { OrgRow } from '@/lib/services/orgs';
import { CreatorDeletedField } from './creator-deleted-field';
import { useAction } from './use-action';

export function OrgSettings({ org }: { org: Pick<OrgRow, 'id' | 'name' | 'require_template_approval' | 'creator_deleted_action'> }) {
  const { run, busy, error } = useAction();
  const [name, setName] = useState(org.name);
  const [approval, setApproval] = useState(org.require_template_approval);
  const [onCreatorDeleted, setOnCreatorDeleted] = useState(org.creator_deleted_action);
  const [saved, setSaved] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    setSaved(await run(`/api/orgs/${org.id}`, { method: 'PATCH', body: { name, require_template_approval: approval, creator_deleted_action: onCreatorDeleted } }));
  }
  return (
    <form onSubmit={submit} className="panel space-y-3 p-5">
      <label className="block">
        <span className="text-sm text-muted">組織名稱</span>
        <input required value={name} onChange={(e) => setName(e.target.value)} className="field" />
      </label>
      <label className="flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
        成員放顧問要管理員核准
      </label>
      <CreatorDeletedField value={onCreatorDeleted} onChange={setOnCreatorDeleted} />
      <div className="flex items-center gap-3">
        <button disabled={busy} className="btn btn-primary btn-sm">{busy ? '儲存中…' : '儲存'}</button>
        {saved && <span className="hint mt-0">已儲存</span>}
      </div>
      {error && <p role="alert" className="notice notice-error">{error}</p>}
    </form>
  );
}
