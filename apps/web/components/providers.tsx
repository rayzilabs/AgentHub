'use client';

import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';

/** 全站的彈簧預設：臨界阻尼、不回彈；使用者開啟「減少動態」時只保留淡入淡出。 */
export function Providers({ children }: { children: React.ReactNode }) {
  // 導覽列高度會隨手機/桌面換行改變，寫成 --nav-h 讓其他 sticky 元素接在它下面
  useEffect(() => {
    const nav = document.getElementById('site-nav');
    if (!nav) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--nav-h', `${nav.offsetHeight}px`));
    ro.observe(nav);
    return () => ro.disconnect();
  }, []);
  return (
    <MotionConfig reducedMotion="user" transition={{ type: 'spring', bounce: 0, visualDuration: 0.35 }}>
      {children}
    </MotionConfig>
  );
}
