'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';

type Memory = {
  id: string; instance_id: string | null; agent_name: string | null;
  name: string; description: string; type: string; content: string; updated_at: string;
};

const TYPE_LABELS: Record<string, string> = { user: '使用者', feedback: '工作方式', project: '專案', reference: '參考資料' };

export function MemoryPanel({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  // null = 還在載入，避免載入中先閃出「還沒有記憶」
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; description: string; content: string } | null>(null);
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
      <h2 id="memory-title" className="group-title">記憶</h2>
      {error && <p role="alert" className="notice notice-error mb-2">{error}</p>}
      <ul className="panel divide-y divide-line/70 px-4 py-1 text-sm">
        {memories === null && <li className="py-3 text-muted">載入中…</li>}
        {memories?.length === 0 && <li className="py-3 text-muted">還沒有記憶。</li>}
        {memories?.map((m) => (
          <li key={m.id} className="py-3">
            <div className="text-sm text-muted">
              {m.agent_name ? `${m.agent_name}（私有）` : '整個專案共用'} · {TYPE_LABELS[m.type] ?? m.type}
            </div>
            {editing?.id === m.id ? (
              <div className="mt-1 space-y-1">
                <input className="field mt-0 text-sm" aria-label="說明" value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                <textarea className="field mt-0 text-sm" rows={3} aria-label="內容" value={editing.content}
                  onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
                <div className="flex gap-3">
                  <button onClick={save} className="link py-1 text-sm">儲存</button>
                  <button onClick={() => setEditing(null)} className="link py-1 text-sm text-muted hover:text-ink">取消</button>
                </div>
              </div>
            ) : (
              <>
                <p className="font-medium">{m.description}</p>
                <p className="whitespace-pre-wrap">{m.content}</p>
                <div className="flex gap-3">
                  <button onClick={() => setEditing({ id: m.id, description: m.description, content: m.content })} className="link py-1 text-sm">修改</button>
                  <button onClick={() => remove(m.id)} className="link py-1 text-sm text-seal hover:text-seal">刪除</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="hint px-1">顧問會記下你說過的事實、偏好與指示，並自己更新；你也可以修改或刪除。</p>
    </section>
  );
}
