'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileButton } from '@/components/file-button';
import { api } from '@/lib/client-api';
import {
  canPublish, canRetire, POLL_MS, pollingIds, secretRowsToSave, statusChip, statusLabel, visibleVersions, zipProblem,
} from '@/lib/hosted-ui';
import type { HostedVersionView } from '@/lib/services/hosted-mcp';

type Message = { kind: 'ok' | 'error'; text: string } | null;

/** 平台代管 MCP：金鑰、部署新版本、版本列表（發布、下架）。只在 MCP 已儲存為平台代管時使用。 */
export function HostedMcpPanel({ templateId, mcpName }: { templateId: string; mcpName: string }) {
  const base = `/api/templates/${templateId}/hosted/${encodeURIComponent(mcpName)}`;
  const [versions, setVersions] = useState<HostedVersionView[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [rows, setRows] = useState([{ key: '', value: '' }]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const fetchAll = useCallback(
    () => Promise.all([api<HostedVersionView[]>(`${base}/versions`), api<{ keys: string[] }>(`${base}/secrets`)]),
    [base],
  );
  const load = useCallback(async () => {
    const [vs, s] = await fetchAll();
    setVersions(vs);
    setKeys(s.keys);
  }, [fetchAll]);

  useEffect(() => {
    let cancelled = false;
    fetchAll().then(([vs, s]) => {
      if (cancelled) return;
      setVersions(vs);
      setKeys(s.keys);
    }, (e) => { if (!cancelled) setMessage({ kind: 'error', text: (e as Error).message }); });
    return () => { cancelled = true; };
  }, [fetchAll]);

  // 部署中的版本每 5 秒讀一次；讀取本身會推進部署（離開頁面再回來也會繼續）
  const polling = pollingIds(versions).join(',');
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      for (const id of polling.split(',')) {
        api<HostedVersionView>(`${base}/versions/${id}`)
          .then((v) => setVersions((all) => all.map((x) => (x.id === v.id ? { ...v, projects: x.projects } : x))))
          .catch((e) => setMessage({ kind: 'error', text: (e as Error).message }));
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, base]);

  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ kind: 'ok', text: label });
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      await load().catch(() => undefined);
      setBusy(false);
    }
  }

  const saveSecrets = () => {
    const secrets = secretRowsToSave(rows);
    if (Object.keys(secrets).length === 0) {
      setMessage({ kind: 'error', text: '請填寫金鑰名稱與值' });
      return;
    }
    void act('金鑰已儲存，執行中的版本會重新啟動', async () => {
      await api(`${base}/secrets`, { method: 'PUT', body: JSON.stringify({ secrets }) });
      setRows([{ key: '', value: '' }]);
    });
  };

  async function deploy(file: File) {
    const problem = zipProblem(file);
    if (problem) {
      setMessage({ kind: 'error', text: problem });
      return;
    }
    setUploading(true);
    await act('已開始部署，大約需要 1 分鐘', async () => {
      const { version, signedUrl } = await api<{ version: HostedVersionView; signedUrl: string }>(`${base}/versions`, { method: 'POST' });
      const res = await fetch(signedUrl, { method: 'PUT', body: file, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
      if (!res.ok) throw new Error(`上傳失敗（${res.status}），請下架這個等待上傳的版本後再試一次`);
      await api(`${base}/versions/${version.id}/deploy`, { method: 'POST' });
    });
    setUploading(false);
  }

  const publish = (v: HostedVersionView) =>
    void act(`版本 ${v.version} 已發布，之後新加入的專案會使用這個版本`, () => api(`${base}/versions/${v.id}/publish`, { method: 'POST' }));

  const retire = (v: HostedVersionView) => {
    if (!window.confirm(`確定下架版本 ${v.version}？下架後無法復原。`)) return;
    void act(`版本 ${v.version} 已下架`, () => api(`${base}/versions/${v.id}`, { method: 'DELETE' }));
  };

  const shown = visibleVersions(versions);
  return (
    <div className="space-y-5 rounded-xl border border-line p-4">
      <div>
        <div className="label">金鑰</div>
        <p className="hint">只會注入你的代管程式。值儲存後不會再顯示；同名稱再存一次就是覆寫。</p>
        {keys.length > 0 && <p className="mt-2 text-sm">已設定：{keys.map((k) => <span key={k} className="chip mr-1">{k}</span>)}</p>}
        <div className="mt-2 space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-2">
              <input disabled={busy} className="field" placeholder="名稱，例如 API_KEY" value={r.key} aria-label="金鑰名稱"
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
              <input disabled={busy} className="field" type="password" autoComplete="off" placeholder="值" value={r.value} aria-label="金鑰的值"
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={busy} className="btn btn-sm btn-secondary" onClick={() => setRows([...rows, { key: '', value: '' }])}>再加一個</button>
          <button type="button" disabled={busy} className="btn btn-sm btn-secondary" onClick={saveSecrets}>儲存金鑰</button>
        </div>
      </div>

      <div>
        <div className="label">部署新版本</div>
        <p className="hint">上傳 zip（最大 50 MB），根目錄要有 mcp.json。格式與範本見創作者文件「交給平台代管」。</p>
        <FileButton label="上傳 zip 並部署" accept=".zip,application/zip" busy={busy} uploading={uploading} className="mt-2" onFile={(f) => void deploy(f)} />
      </div>

      <div>
        <div className="label">版本</div>
        {shown.length === 0 && <p className="hint">還沒有版本。</p>}
        <ul className="mt-2 space-y-3">
          {shown.map((v) => (
            <li key={v.id} className="space-y-2 rounded-xl bg-sunken p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">版本 {v.version}</span>
                <span className={`chip ${statusChip(v.status)}`}>{statusLabel(v.status)}</span>
                {v.projects > 0 && <span className="text-sm text-muted">{v.projects} 個專案使用中</span>}
              </div>
              {v.status === 'deploying' && <p className="hint">部署中，每 5 秒自動更新，最長 10 分鐘。</p>}
              {(v.status === 'ready' || v.status === 'published') && v.tools.length > 0 && (
                <p className="text-sm">工具：{(v.tools as { name: string }[]).map((t) => t.name).join('、')}</p>
              )}
              {(v.status === 'deploying' || v.status === 'failed') && v.log_tail && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-3 text-xs">{v.log_tail}</pre>
              )}
              <div className="flex flex-wrap gap-2">
                {canPublish(v) && <button type="button" disabled={busy} className="btn btn-sm btn-primary" onClick={() => publish(v)}>發布這個版本</button>}
                {canRetire(v) && <button type="button" disabled={busy} className="btn btn-sm text-seal hover:bg-seal/10" onClick={() => retire(v)}>下架</button>}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`notice whitespace-pre-line ${message.kind === 'error' ? 'notice-error' : 'notice-info'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
