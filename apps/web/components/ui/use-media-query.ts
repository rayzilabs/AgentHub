'use client';

import { useSyncExternalStore } from 'react';

/** 伺服器端與第一次 hydration 一律回傳 serverValue，之後跟著視窗大小更新 */
export function useMediaQuery(query: string, serverValue: boolean) {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}
