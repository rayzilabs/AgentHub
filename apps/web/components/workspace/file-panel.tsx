'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileButton } from '@/components/file-button';
import { api } from '@/lib/client-api';

type FileItem = { name: string; size: number; updated_at: string | null };

const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function FilePanel({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<FileItem[]>(`/api/projects/${projectId}/files`)
    .then((list) => { setFiles(list); setError(null); })
    .catch((e) => setError(e.message)), [projectId]);
  useEffect(() => { void load(); }, [load]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const { signedUrl } = await api<{ signedUrl: string }>(`/api/projects/${projectId}/files/upload-url`, {
        method: 'POST', body: JSON.stringify({ filename: file.name }),
      });
      const res = await fetch(signedUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-upsert': 'true' } });
      if (!res.ok) throw new Error(`上傳失敗（${res.status}）`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="files-title">
      <h2 id="files-title" className="font-display text-xl">專案資料</h2>
      <p className="text-sm text-muted">上傳後，所有顧問下一次回覆時都讀得到。</p>
      <FileButton label="上傳檔案" busy={busy} className="mt-2" onFile={(f) => void upload(f)} />
      {error && <p role="alert" className="notice notice-error mt-2">{error}</p>}
      <ul className="mt-3 space-y-1 text-sm">
        {files.map((f) => (
          <li key={f.name} className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate" title={f.name}>{f.name}</span>
            <span className="shrink-0 text-muted">{formatSize(f.size)}</span>
          </li>
        ))}
        {files.length === 0 && <li className="text-sm text-muted">還沒有資料。</li>}
      </ul>
    </section>
  );
}
