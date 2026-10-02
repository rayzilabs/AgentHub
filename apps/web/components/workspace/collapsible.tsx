'use client';

import { useId, useState, type ReactNode } from 'react';

/** 長內容預設收合（約 8 行），底部淡出，按鈕展開全文。 */
export function Collapsible({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <div id={id} className={open ? '' : 'relative max-h-48 overflow-hidden'}>
        {children}
        {!open && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" />}
      </div>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
        className="mt-1 text-sm text-brand underline-offset-2 hover:underline">
        {open ? '收合' : '展開全文'}
      </button>
    </div>
  );
}
