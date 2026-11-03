'use client';

import { useState } from 'react';
import type { DeliveredFile } from '@/lib/agent-output';
import { api } from '@/lib/client-api';
import { formatSize } from '@/lib/file-tree';

const DELETED = '檔案已刪除';

function FileCard({ file }: { file: DeliveredFile }) {
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState('');
  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await api<{ url: string; name: string }>(`/api/files/${file.file_id}/download`);
      window.location.assign(url);
    } catch (e) {
      // api() 只留下伺服器的錯誤訊息，404 的訊息固定是「檔案已刪除」
      if ((e as Error).message === DELETED) setDeleted(true);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <div className={`panel flex items-center justify-between gap-3 px-4 py-3 ${deleted ? 'opacity-60' : ''}`}>
        <div className="min-w-0">
          <p className={`truncate font-medium ${deleted ? 'text-muted line-through' : ''}`}>{file.name}</p>
          <p className="truncate text-sm text-muted">
            {file.folder}・{formatSize(file.size)}
            {deleted && <span className="ml-2 text-seal">{DELETED}</span>}
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm shrink-0" disabled={busy || deleted} aria-label={`下載 ${file.name}`} onClick={() => void download()}>
          下載
        </button>
      </div>
      {error && <p role="alert" className="notice notice-error mt-2">{error}</p>}
    </li>
  );
}

export function FileCards({ files }: { files: DeliveredFile[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="my-3 space-y-2">
      {files.map((f) => <FileCard key={f.file_id} file={f} />)}
    </ul>
  );
}
