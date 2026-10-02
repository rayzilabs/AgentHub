'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';
import type { McpServer } from '@/lib/schemas';

type ProjectOption = { id: string; name: string };
/** 只需要 MCP 名稱與需要的金鑰；不會拿到創作者的指令、網址或 headers。 */
type HireMcpServer = Pick<McpServer, 'name' | 'required_secrets'>;

export function HireForm({ templateId, mcpServers, projects }: { templateId: string; mcpServers: HireMcpServer[]; projects: ProjectOption[] }) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [secrets, setSecrets] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needed = mcpServers.flatMap((s) => (s.required_secrets ?? []).map((r) => ({ server: s.name, ...r })));

  if (projects.length === 0) {
    return (
      <p className="text-muted">
        要先有一個專案才能加入顧問。<Link href="/projects" className="text-brand underline">建立專案</Link>
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/agents`, { method: 'POST', body: JSON.stringify({ template_id: templateId, secrets }) });
      router.push(`/projects/${projectId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="text-sm text-muted">加入哪個專案</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface px-3 py-2">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {needed.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="text-sm text-muted">這位顧問的工具需要你的金鑰（只會存在你的專案裡）</legend>
          {needed.map((n) => (
            <label key={`${n.server}.${n.key}`} className="block">
              <span className="text-sm">{n.server} 的 {n.key}{n.description ? `：${n.description}` : ''}</span>
              <input
                required
                type="password"
                autoComplete="off"
                value={secrets[n.server]?.[n.key] ?? ''}
                onChange={(e) => setSecrets((s) => ({ ...s, [n.server]: { ...s[n.server], [n.key]: e.target.value } }))}
                className="mt-1 w-full rounded border border-line bg-surface px-3 py-2"
              />
            </label>
          ))}
        </fieldset>
      )}
      {error && <p role="alert" className="text-sm text-seal">{error}</p>}
      <button disabled={busy} className="rounded bg-brand px-4 py-2 text-white disabled:opacity-60">
        {busy ? '加入中…' : '加入這位顧問'}
      </button>
    </form>
  );
}
