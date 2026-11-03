'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { Chevron } from '@/components/chevron';
import { FileBrowser } from '@/components/files/file-browser';

/** 我的雲端的一個專案區塊：預設收合，展開後才載入這個專案的檔案樹 */
export function CloudProject({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div>
      <div className="flex items-center gap-3">
        <button type="button" aria-expanded={open} aria-controls={panelId} aria-label={`${open ? '收合' : '展開'}專案 ${name}`}
          onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left">
          <Chevron className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
          <span className="min-w-0 flex-1 text-xl font-medium [overflow-wrap:anywhere]">{name}</span>
        </button>
        <Link href={`/projects/${id}`} className="btn btn-secondary btn-sm shrink-0">開啟專案</Link>
      </div>
      {/* 收合時內容不掛載，避免每個專案都先打一次 API */}
      <div id={panelId} hidden={!open} className="mt-2">
        {open && <FileBrowser projectId={id} title={`${name} 的檔案`} />}
      </div>
    </div>
  );
}
