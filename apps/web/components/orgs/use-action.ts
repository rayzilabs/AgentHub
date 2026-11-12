'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';

/** 送出一個 API 動作；成功後重新抓頁面資料，失敗把 API 的錯誤訊息顯示出來。 */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T = unknown>(path: string, init: { method: string; body?: unknown }, onDone?: (result: T) => void): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const result = await api<T>(path, { method: init.method, json: init.body });
      if (onDone) onDone(result);
      else router.refresh();
      setBusy(false);
      return true;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return false;
    }
  }
  return { run, busy, error };
}

export const dateText = (iso: string) => new Date(iso).toLocaleDateString('zh-TW');
