'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** 收合時的高度（約 10 行） */
const CLAMP_PX = 224;

/** 長內容預設收合，只有內容真的超出時才出現淡出與「展開全文」；展開與收合用彈簧從目前高度接續。 */
export function Collapsible({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // 使用者按過之前，高度變化（例如內容載入後才知道超出）直接套用，不播動畫
  const [touched, setTouched] = useState(false);
  const inner = useRef<HTMLDivElement>(null);
  const id = useId();
  const reduce = useReducedMotion();

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollHeight > CLAMP_PX + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  const clamped = overflows && !open;
  return (
    <div>
      <motion.div id={id} initial={false} animate={{ height: clamped ? CLAMP_PX : 'auto' }} transition={touched && !reduce ? undefined : { duration: 0 }} className="relative overflow-hidden">
        <div ref={inner}>{children}</div>
        <motion.div aria-hidden initial={false} animate={{ opacity: clamped ? 1 : 0 }} transition={{ duration: 0.2 }}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" />
      </motion.div>
      {overflows && (
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => { setTouched(true); setOpen(!open); }}
          className="btn btn-plain btn-sm -ml-2 mt-1">
          {open ? '收合' : '展開全文'}
        </button>
      )}
    </div>
  );
}
