'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';

export function NewProjectForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ id: string }>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
      router.push(`/projects/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
      <label className="min-w-0 flex-1 basis-64">
        <span className="sr-only">專案名稱</span>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：第四季新產品上市"
          className="field mt-0 rounded-full px-5" />
      </label>
      <button disabled={busy} className="btn btn-primary min-h-12">{busy ? '建立中…' : '建立專案'}</button>
      {error && <p role="alert" className="notice notice-error w-full">{error}</p>}
    </form>
  );
}
