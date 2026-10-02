'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';

export function NewTemplateButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    try {
      const t = await api<{ id: string }>('/api/templates', { method: 'POST', body: JSON.stringify({ name: '未命名的顧問' }) });
      router.push(`/creator/${t.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div>
      <button onClick={create} disabled={busy} className="rounded bg-brand px-4 py-2 text-white disabled:opacity-60">
        {busy ? '建立中…' : '做一位新顧問'}
      </button>
      {error && <p role="alert" className="mt-2 text-sm text-seal">{error}</p>}
    </div>
  );
}
