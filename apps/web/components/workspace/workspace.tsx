'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Chevron } from '@/components/chevron';
import { Avatar, MANAGER_COLOR } from '@/components/ui/avatar';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { useMediaQuery } from '@/components/ui/use-media-query';
import { api } from '@/lib/client-api';
import { consultantColor } from '@/lib/colors';
import type { ProjectDetail } from '@/lib/services/projects';
import { AgentRoster } from './agent-roster';
import { Chat } from './chat';
import { FilePanel } from './file-panel';
import { MemoryPanel } from './memory-panel';
import { ThreadTabs } from './thread-tabs';

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
  // 純呈現：手機上底部面板的開關，不影響資料流
  const [panelOpen, setPanelOpen] = useState(false);
  // 面板只渲染在一個地方：桌面在側欄、手機在底部面板，避免重複抓資料
  const isDesktop = useMediaQuery('(min-width: 1024px)', true);
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
  const speakerColor = consultants.length > 1 ? MANAGER_COLOR : colorOf(consultants[0]?.id ?? '');

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

  const panels = (
    <div className="space-y-8">
      <AgentRoster agents={agents} colorOf={colorOf} />
      <FilePanel projectId={project.id} />
      <MemoryPanel projectId={project.id} refreshKey={memoryTick + threads.length} />
      <button onClick={remove} className="btn btn-sm -ml-3 text-seal hover:bg-seal/10">刪除專案</button>
    </div>
  );

  return (
    <div className="grid gap-6 py-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-10 lg:py-8">
      <aside className="min-w-0 lg:sticky lg:top-[calc(var(--nav-h,57px)+2rem)] lg:-ml-1 lg:max-h-[calc(100dvh-var(--nav-h,57px)-4rem)] lg:self-start lg:overflow-y-auto lg:pb-1 lg:pl-1 lg:pr-1">
        {/* 標題與環境狀態：手機也永遠看得到 */}
        <div>
          <h1 className="font-display text-2xl font-bold">{project.name}</h1>
          {project.sprite_status === 'provisioning' && (
            <div role="status" className="notice notice-info mt-3">
              <p className="flex items-center gap-2 font-medium"><span className="dot-busy" aria-hidden />正在準備 agent 的工作電腦，約需一分鐘</p>
              <p className="mt-1 text-muted">準備好之後就能送出訊息，這段時間可以先上傳資料。</p>
              {stalled && (
                <>
                  <p className="mt-2 text-muted">準備時間比平常久，可以重新準備。</p>
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

        {/* 手機：一列按鈕叫出底部面板；桌面：面板直接放在側欄 */}
        <button type="button" onClick={() => setPanelOpen(true)} aria-haspopup="dialog" aria-expanded={panelOpen}
          className="panel mt-4 flex w-full items-center gap-3 px-4 py-3 text-left transition-transform duration-100 active:scale-[0.98] lg:hidden">
          <span className="flex -space-x-2">
            {consultants.slice(0, 3).map((a) => <span key={a.id} className="rounded-full ring-2 ring-surface"><Avatar name={a.name} color={colorOf(a.id)} size="sm" /></span>)}
          </span>
          <span className="min-w-0 flex-1 font-medium">顧問、資料與記憶</span>
          <Chevron className="-rotate-90" />
        </button>

        <div className="hidden lg:mt-8 lg:block">{isDesktop && panels}</div>
      </aside>

      {!isDesktop && (
        <BottomSheet open={panelOpen} onClose={() => setPanelOpen(false)} title="顧問、資料與記憶">
          {panels}
        </BottomSheet>
      )}

      <section aria-label="對話" className="min-w-0">
        <ThreadTabs threads={threads} threadId={threadId} onSelect={setThreadId} onNew={newThread} error={error} />
        {consultants.length === 0 ? (
          <div className="panel p-6">
            <p className="text-xl font-semibold">這張工作桌還沒有顧問</p>
            <p className="mt-1 text-muted">到市集挑一位加進來就能開始對話；加到第二位時會自動多一位主管幫你分工。</p>
            <Link href="/" className="btn btn-primary mt-4">到市集挑顧問</Link>
          </div>
        ) : threadId ? (
          <Chat key={threadId} threadId={threadId} ready={project.sprite_status === 'ready'} speaker={speaker} speakerColor={speakerColor} hasManager={consultants.length > 1} colorOf={colorOf} onSettled={() => setMemoryTick((n) => n + 1)} />
        ) : (
          <div className="panel p-6">
            <p className="text-xl font-semibold">還沒有對話</p>
            <p className="mt-1 text-muted">開一個對話，說明你想完成的事，顧問就會開始工作。</p>
            <button onClick={newThread} className="btn btn-primary mt-4">開始第一個對話</button>
          </div>
        )}
      </section>
    </div>
  );
}
