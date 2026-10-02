'use client';

import { useId } from 'react';

/** 隱藏原生檔案欄位，改用品牌外框按鈕；鍵盤焦點會顯示在按鈕上。 */
export function FileButton({ label, busy, accept, onFile, className = '' }: {
  label: string;
  busy: boolean;
  accept?: string;
  onFile: (file: File) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`inline-block ${className}`}>
      <input id={id} type="file" accept={accept} disabled={busy} className="peer sr-only"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      <label htmlFor={id}
        className="inline-flex min-h-10 cursor-pointer items-center rounded border border-brand px-4 text-sm text-brand hover:bg-brand-soft peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand peer-disabled:cursor-not-allowed peer-disabled:opacity-60">
        {busy ? '上傳中…' : label}
      </label>
    </div>
  );
}
