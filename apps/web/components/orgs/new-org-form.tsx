'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAction } from './use-action';

export function NewOrgForm() {
  const router = useRouter();
  const { run, busy, error } = useAction();
  const [name, setName] = useState('');
  const [approval, setApproval] = useState(false);
  function submit(e: React.FormEvent) {
    e.preventDefault();
    void run<{ id: string }>('/api/orgs', { method: 'POST', body: { name, require_template_approval: approval } }, (o) => router.push(`/orgs/${o.id}`));
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="min-w-0 flex-1 basis-64">
          <span className="sr-only">組織名稱</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：睿子資訊工作室" className="field mt-0 rounded-full px-5" />
        </label>
        <button disabled={busy} className="btn btn-primary min-h-12">{busy ? '建立中…' : '建立組織'}</button>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
        成員放顧問要管理員核准
      </label>
      {error && <p role="alert" className="notice notice-error">{error}</p>}
    </form>
  );
}
