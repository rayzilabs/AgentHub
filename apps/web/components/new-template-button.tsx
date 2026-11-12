'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';

export function NewTemplateButton({ orgId }: { orgId?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    try {
      const t = await api<{ id: string }>('/api/templates', { method: 'POST', json: { name: '未命名的顧問', ...(orgId && { org_id: orgId }) } });
      router.push(`/creator/${t.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div>
      <button onClick={create} disabled={busy} className="btn btn-primary">
        {busy ? '建立中…' : '做一位新顧問'}
      </button>
      {error && <p role="alert" className="notice notice-error mt-2">{error}</p>}
    </div>
  );
}
