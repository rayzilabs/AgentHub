'use client';

import { useId } from 'react';

/** 隱藏原生檔案欄位，改用品牌外框按鈕；鍵盤焦點會顯示在按鈕上。 */
export function FileButton({ label, busy, uploading = busy, accept, onFile, className = '' }: {
  label: string;
  busy: boolean;
  uploading?: boolean;
  accept?: string;
  onFile: (file: File) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`relative inline-block ${className}`}>
      <input id={id} type="file" accept={accept} disabled={busy} className="peer sr-only"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      <label htmlFor={id}
        className="btn btn-secondary btn-sm cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand peer-disabled:cursor-not-allowed peer-disabled:opacity-60">
        {uploading ? '上傳中…' : label}
      </label>
    </div>
  );
}
