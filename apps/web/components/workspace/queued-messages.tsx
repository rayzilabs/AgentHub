'use client';

import { useState } from 'react';
import type { QueuedView } from '@/lib/services/threads';

function QueuedItem({ item, onEdit, onDelete }: {
  item: QueuedView;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    const text = draft?.trim();
    setDraft(null);
    if (text && text !== item.text) onEdit(item.id, text);
  };

  if (draft !== null) {
    return (
      <li className="rounded-2xl bg-surface p-2 shadow-float">
        <label>
          <span className="sr-only">編輯排隊訊息</span>
          <textarea value={draft} rows={2} autoFocus onChange={(e) => setDraft(e.target.value)}
            className="block w-full resize-none bg-transparent text-base text-ink focus:outline-none" />
        </label>
        <div className="mt-1 flex justify-end gap-3 text-sm">
          <button type="button" onClick={() => setDraft(null)} className="text-muted active:scale-95">取消</button>
          <button type="button" onClick={save} disabled={!draft.trim()} className="font-medium text-link active:scale-95 disabled:opacity-40">儲存</button>
        </div>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-3 rounded-2xl bg-surface px-3.5 py-2 shadow-float">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-ink">{item.text}</span>
      <span className="flex shrink-0 gap-3 text-sm">
        <button type="button" onClick={() => setDraft(item.text)} className="text-link active:scale-95">編輯</button>
        <button type="button" onClick={() => onDelete(item.id)} className="text-muted active:scale-95">刪除</button>
      </span>
    </li>
  );
}

/** 執行中排隊的訊息：agent 走到下一步時讀走，讀走之前可以編輯或刪除 */
export function QueuedMessages({ items, onEdit, onDelete }: {
  items: QueuedView[];
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="排隊中的訊息" className="mb-2 space-y-1.5">
      {items.map((item) => <QueuedItem key={item.id} item={item} onEdit={onEdit} onDelete={onDelete} />)}
    </ul>
  );
}
