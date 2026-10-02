'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';

type Memory = { id: string; instance_id: string | null; agent_name: string | null; content: string; created_at: string };

export function MemoryPanel({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<Memory[]>(`/api/projects/${projectId}/memories`)
    .then((list) => { setMemories(list); setError(null); })
    .catch((e) => setError(e.message)), [projectId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function save() {
    if (!editing) return;
    try {
      await api(`/api/projects/${projectId}/memories`, { method: 'PATCH', body: JSON.stringify(editing) });
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('確定要刪除這筆記憶？')) return;
    try {
      await api(`/api/projects/${projectId}/memories?id=${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section aria-labelledby="memory-title">
      <h2 id="memory-title" className="font-display text-xl">記憶</h2>
      <p className="text-sm text-muted">顧問記下你說過的事實與偏好，你可以修改或刪除。</p>
      {error && <p role="alert" className="notice notice-error mt-2">{error}</p>}
      <ul className="mt-2 space-y-2 text-sm">
        {memories.length === 0 && <li className="text-sm text-muted">還沒有記憶。</li>}
        {memories.map((m) => (
          <li key={m.id} className="border-l-2 border-line pl-2">
            <div className="text-sm text-muted">{m.agent_name ? `${m.agent_name}（私有）` : '整個專案共用'}</div>
            {editing?.id === m.id ? (
              <div className="mt-1 space-y-1">
                <textarea className="field mt-0 text-sm" rows={3} value={editing.content}
                  onChange={(e) => setEditing({ id: m.id, content: e.target.value })} />
                <div className="flex gap-3">
                  <button onClick={save} className="link py-1 text-sm">儲存</button>
                  <button onClick={() => setEditing(null)} className="link py-1 text-sm text-muted hover:text-ink">取消</button>
                </div>
              </div>
            ) : (
              <>
                <p>{m.content}</p>
                <div className="flex gap-3">
                  <button onClick={() => setEditing({ id: m.id, content: m.content })} className="link py-1 text-sm">修改</button>
                  <button onClick={() => remove(m.id)} className="link py-1 text-sm text-seal hover:text-seal">刪除</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
