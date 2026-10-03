'use client';

import { motion } from 'motion/react';

type Thread = { id: string; title: string };

/**
 * 對話分頁：分段控制，選中的底色會從原本的位置滑到新的分頁。
 * 分頁列是對話區的第一個 div，按鈕是它的直接子元素（截圖腳本依賴這個結構）。
 */
export function ThreadTabs({ threads, threadId, onSelect, onNew, error }: {
  threads: Thread[];
  threadId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  error: string | null;
}) {
  return (
    <div className="material sticky top-[var(--nav-h,57px)] z-20 -mx-4 mb-6 flex flex-wrap items-center gap-2 px-4 py-2.5 sm:mx-0 sm:rounded-[22px] sm:px-1.5 sm:py-1.5 sm:shadow-float">
      {threads.map((t, i) => {
        const active = t.id === threadId;
        return (
          <button key={t.id} onClick={() => onSelect(t.id)} aria-current={active ? 'true' : undefined} title={t.title !== '新對話' ? t.title : undefined}
            className={`relative inline-flex min-h-8 max-w-full select-none items-center rounded-full px-3.5 text-sm transition-[color,transform] duration-100 active:scale-[0.97] ${active ? 'font-medium text-ink' : 'text-muted hover:text-ink'}`}>
            {active && <motion.span layoutId="thread-pill" aria-hidden className="absolute inset-0 rounded-full bg-surface shadow-float" />}
            <span className="relative truncate">{t.title === '新對話' ? `對話 ${threads.length - i}` : t.title}</span>
          </button>
        );
      })}
      <button onClick={onNew} className="btn btn-plain btn-sm sm:ml-auto">
        <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 1v10M1 6h10" /></svg>
        開新對話
      </button>
      {error && <p role="alert" className="notice notice-error w-full">{error}</p>}
    </div>
  );
}
