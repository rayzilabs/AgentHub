'use client';

import Link from 'next/link';
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
  // 純呈現：手機上側欄三個面板的展開狀態，不影響資料流
  const [panelOpen, setPanelOpen] = useState(false);
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
    <div className="grid gap-6 py-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-10 lg:py-8">
      <aside className="min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
        {/* 標題與環境狀態：手機也永遠看得到 */}
        <div>
          <h1 className="font-display text-2xl leading-tight">{project.name}</h1>
          {project.sprite_status === 'provisioning' && (
            <div role="status" className="notice notice-info mt-3">
              <p className="flex items-center gap-2 text-ink"><span className="dot-busy" aria-hidden />正在準備 agent 的工作電腦，約需一分鐘</p>
              <p className="mt-1">準備好之後就能送出訊息，這段時間可以先上傳資料。</p>
              {stalled && (
                <>
                  <p className="mt-2">準備時間比平常久，可以重新準備。</p>
                  <button onClick={retry} className="btn btn-secondary btn-sm mt-2">重新準備</button>
                </>
              )}
            </div>
          )}
          {project.sprite_status === 'error' && (
            <div role="alert" className="notice notice-error mt-3">
              <p className="font-medium">工作電腦準備失敗</p>
              <p className="mt-1 text-ink">{project.sprite_error}</p>
              <button onClick={retry} className="btn btn-secondary btn-sm mt-2">重新準備</button>
            </div>
          )}
        </div>

        {/* 手機：一顆開關收合側欄面板；桌面：隱藏 */}
        <button type="button" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen} aria-controls="workspace-panels"
          className="btn btn-secondary mt-4 w-full justify-between lg:hidden">
          <span>顧問、資料與記憶</span>
          <span className="text-muted">{panelOpen ? '收起' : '展開'}</span>
        </button>

        <div id="workspace-panels" className={`${panelOpen ? 'mt-6 block' : 'hidden'} space-y-8 lg:mt-8 lg:block`}>
          <AgentRoster agents={agents} colorOf={colorOf} />
          <FilePanel projectId={project.id} />
          <MemoryPanel projectId={project.id} refreshKey={memoryTick + threads.length} />
          <div className="border-t border-line pt-4">
            <button onClick={remove} className="link text-sm text-seal hover:text-seal">刪除專案</button>
          </div>
        </div>
      </aside>

      <section aria-label="對話" className="min-w-0">
        <div className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-2 border-b border-line bg-paper px-4 py-3 sm:mx-0 sm:px-0">
          {threads.map((t, i) => (
            <button key={t.id} onClick={() => setThreadId(t.id)} aria-current={t.id === threadId ? 'true' : undefined} title={t.title}
              className={`btn btn-sm max-w-full truncate ${t.id === threadId ? 'btn-primary' : 'btn-secondary'}`}>
              {t.title === '新對話' ? `對話 ${threads.length - i}` : t.title}
            </button>
          ))}
          <button onClick={newThread} className="btn btn-sm border border-dashed border-line text-muted hover:border-ink hover:text-ink">開新對話</button>
          {error && <p role="alert" className="notice notice-error w-full">{error}</p>}
        </div>
        {consultants.length === 0 ? (
          <div className="panel p-6">
            <p className="font-display text-xl">這張工作桌還沒有顧問</p>
            <p className="mt-1 text-muted">到市集挑一位加進來就能開始對話；加到第二位時會自動多一位主管幫你分工。</p>
            <Link href="/" className="btn btn-primary mt-4">到市集挑顧問</Link>
          </div>
        ) : threadId ? (
          <Chat key={threadId} threadId={threadId} ready={project.sprite_status === 'ready'} speaker={speaker} hasManager={consultants.length > 1} colorOf={colorOf} onSettled={() => setMemoryTick((n) => n + 1)} />
        ) : (
          <div className="panel p-6">
            <p className="font-display text-xl">還沒有對話</p>
            <p className="mt-1 text-muted">開一個對話，說明你想完成的事，顧問就會開始工作。</p>
            <button onClick={newThread} className="btn btn-primary mt-4">開始第一個對話</button>
          </div>
        )}
      </section>
    </div>
  );
}
