'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** 長內容預設收合（約 10 行），只有內容真的超出時才出現淡出與「展開全文」按鈕。 */
export function Collapsible({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, children]);

  const clamped = !open;
  return (
    <div>
      <div ref={ref} id={id} className={clamped ? 'relative max-h-56 overflow-hidden' : ''}>
        {children}
        {clamped && overflows && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent" />}
      </div>
      {(overflows || open) && (
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
          className="link mt-2 text-sm no-underline hover:underline">
          {open ? '收合' : '展開全文'}
        </button>
      )}
    </div>
  );
}
