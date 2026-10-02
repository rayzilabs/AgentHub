'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { consultantColor } from '@/lib/colors';
import type { ProjectDetail } from '@/lib/services/projects';
import { AgentRoster } from './agent-roster';
import { Chat } from './chat';
import { FilePanel } from './file-panel';
import { MemoryPanel } from './memory-panel';

// 準備超過這個時間仍未完成（例如背景部署被中斷），讓使用者可以重新準備
const STALLED_MS = 120_000;

export function Workspace({ initial }: { initial: ProjectDetail }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [threadId, setThreadId] = useState<string | null>(initial.threads[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [memoryTick, setMemoryTick] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [provisionRun, setProvisionRun] = useState(0);
  const { project, agents, threads } = detail;

  const reload = useCallback(async () => {
    try {
      setDetail(await api<ProjectDetail>(`/api/projects/${project.id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project.id]);

  useEffect(() => {
    if (project.sprite_status !== 'provisioning') return;
    const timer = setInterval(() => { void reload(); }, 3000);
    return () => clearInterval(timer);
  }, [project.sprite_status, reload]);

  useEffect(() => {
    if (project.sprite_status !== 'provisioning') return;
    const timer = setTimeout(() => setStalled(true), STALLED_MS);
    return () => clearTimeout(timer);
  }, [project.sprite_status, provisionRun]);

  const consultants = agents.filter((a) => a.role === 'consultant');
  const colorOf = (id: string) => consultantColor(Math.max(0, consultants.findIndex((a) => a.id === id)));
  const speaker = consultants.length > 1 ? '主管' : consultants[0]?.name ?? '顧問';

  async function newThread() {
    try {
      const t = await api<{ id: string }>(`/api/projects/${project.id}/threads`, { method: 'POST', body: JSON.stringify({}) });
      await reload();
      setThreadId(t.id);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function retry() {
    setStalled(false);
    setProvisionRun((n) => n + 1);
    try {
      await api(`/api/projects/${project.id}/provision`, { method: 'POST' });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove() {
    if (!window.confirm(`確定要刪除「${project.name}」？對話、記憶和資料都會一起刪除。`)) return;
    try {
      await api(`/api/projects/${project.id}`, { method: 'DELETE' });
      router.push('/projects');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="grid gap-8 py-8 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-8">
        <div>
          <h1 className="font-display text-[28px] leading-tight">{project.name}</h1>
          {project.sprite_status === 'provisioning' && (
            <div className="mt-1 text-sm">
              <p className="text-muted">正在準備 agent 的工作電腦，約需一分鐘…</p>
              {stalled && (
                <>
                  <p className="mt-1 text-muted">準備時間比平常久，可以重新準備。</p>
                  <button onClick={retry} className="mt-1 text-brand underline">重新準備</button>
                </>
              )}
            </div>
          )}
          {project.sprite_status === 'error' && (
            <div className="mt-2 text-sm">
              <p className="text-seal">準備失敗：{project.sprite_error}</p>
              <button onClick={retry} className="mt-1 text-brand underline">重新準備</button>
            </div>
          )}
        </div>
        <AgentRoster agents={agents} colorOf={colorOf} />
        <FilePanel projectId={project.id} />
        <MemoryPanel projectId={project.id} refreshKey={memoryTick + threads.length} />
        <button onClick={remove} className="text-sm text-seal underline">刪除專案</button>
      </aside>

      <section aria-label="對話">
        <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-line pb-3">
          {threads.map((t, i) => (
            <button key={t.id} onClick={() => setThreadId(t.id)}
              className={`rounded px-3 py-1 text-sm ${t.id === threadId ? 'bg-brand text-white' : 'border border-line hover:border-ink'}`}>
              {t.title === '新對話' ? `對話 ${threads.length - i}` : t.title}
            </button>
          ))}
          <button onClick={newThread} className="rounded border border-dashed border-line px-3 py-1 text-sm hover:border-ink">開新對話</button>
          {error && <p role="alert" className="w-full text-sm text-seal">{error}</p>}
        </div>
        {consultants.length === 0 ? (
          <p className="text-muted">先到市集加入至少一位顧問，才能開始對話。</p>
        ) : threadId ? (
          <Chat key={threadId} threadId={threadId} ready={project.sprite_status === 'ready'} speaker={speaker} hasManager={consultants.length > 1} colorOf={colorOf} onSettled={() => setMemoryTick((n) => n + 1)} />
        ) : (
          <button onClick={newThread} className="rounded bg-brand px-4 py-2 text-white">開始第一個對話</button>
        )}
      </section>
    </div>
  );
}
