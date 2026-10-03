'use client';

import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';

/** 依放手時的速度推算會停在哪裡（與捲動減速相同的指數衰減） */
function project(velocity: number, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** 拉過邊界時越拉越緊，不會硬停住 */
function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

type Drag = { pointerId: number; startY: number; origin: number; samples: { t: number; y: number }[] };

/**
 * 手機的底部面板：從下方升起、往下拖或甩就收起，拖到一半可以再往上推回去。
 * 用原生 <dialog> 取得焦點鎖定與 Esc；動畫一律從畫面上的目前位置出發，並承接手指的速度。
 */
export function BottomSheet({ open, onClose, title, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  // y：面板往下的位移（0 = 完全打開）；fade：減少動態時改用淡入淡出
  const y = useMotionValue(0);
  const fade = useMotionValue(1);
  const anims = useRef<ReturnType<typeof animate>[]>([]);
  const drag = useRef<Drag | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  const height = () => (panel.current?.offsetHeight ?? 600) + 24;
  const scrim = useTransform(() => fade.get() * Math.max(0, Math.min(1, 1 - y.get() / height())));

  const stop = () => { anims.current.forEach((a) => a.stop()); anims.current = []; };

  const settle = useCallback((target: 'open' | 'closed', velocity = 0) => {
    stop();
    const closing = target === 'closed';
    const finish = closing
      ? () => {
          dialog.current?.close();
          document.documentElement.style.overflow = '';
          closeRef.current();
        }
      : undefined;
    if (reduce) {
      y.jump(0);
      anims.current = [animate(fade, closing ? 0 : 1, { duration: 0.2, ease: 'easeOut', onComplete: finish })];
      return;
    }
    // 只有帶著動量甩回來時才有一點回彈；收起時不回彈
    const bounce = !closing && Math.abs(velocity) > 600 ? 0.15 : 0;
    anims.current = [animate(y, closing ? height() : 0, { type: 'spring', velocity, bounce, visualDuration: 0.32, onComplete: finish })];
  }, [reduce, y, fade]);

  // 父層打開：顯示 dialog，從畫面下方升起
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      document.documentElement.style.overflow = 'hidden';
      if (reduce) { y.jump(0); fade.jump(0); } else { fade.jump(1); y.jump(height()); }
      settle('open');
    } else if (!open && el.open) {
      settle('closed');
    }
  }, [open, reduce, settle, y, fade]);

  useEffect(() => () => { stop(); document.documentElement.style.overflow = ''; }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || reduce) return;
    // 隨時可以抓住：停下進行中的動畫，從目前畫面上的位置接手
    stop();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startY: e.clientY, origin: y.get(), samples: [{ t: e.timeStamp, y: y.get() }] };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const raw = d.origin + (e.clientY - d.startY);
    const next = raw < 0 ? -rubberband(-raw, height()) : raw;
    y.set(next);
    d.samples.push({ t: e.timeStamp, y: next });
    while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > 100) d.samples.shift();
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    const first = d.samples[0];
    const last = d.samples.at(-1)!;
    const dt = (last.t - first.t) / 1000;
    const velocity = dt > 0 && e.timeStamp - last.t < 80 ? (last.y - first.y) / dt : 0;
    const projected = y.get() + project(velocity);
    settle(projected > height() / 2 ? 'closed' : 'open', velocity);
  }

  return (
    <dialog ref={dialog} aria-labelledby="sheet-title"
      onCancel={(e) => { e.preventDefault(); settle('closed'); }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden bg-transparent p-0 text-ink backdrop:bg-transparent">
      <motion.div aria-hidden className="absolute inset-0 bg-black/40" style={{ opacity: scrim }} onClick={() => settle('closed')} />
      <motion.div ref={panel} style={{ y, opacity: fade }}
        className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-[28px] bg-paper shadow-sheet will-change-transform">
        {/* 拖曳區：把手與標題列 */}
        <div className="shrink-0 cursor-grab touch-none select-none px-5 pb-2 pt-2 active:cursor-grabbing"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div aria-hidden className="mx-auto h-1.5 w-10 rounded-full bg-line" />
          <div className="mt-2 flex items-center justify-between gap-3">
            <h2 id="sheet-title" className="text-xl font-semibold">{title}</h2>
            <button type="button" onClick={() => settle('closed')} onPointerDown={(e) => e.stopPropagation()} className="btn btn-plain btn-sm font-semibold">完成</button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </motion.div>
    </dialog>
  );
}
