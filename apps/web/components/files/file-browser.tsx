'use client';

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { FileButton } from '@/components/file-button';
import { api } from '@/lib/client-api';
import { ancestorFolderIds, buildTree, descendantFolderIds, folderPath, formatSize, isValidSelection, type TreeNode } from '@/lib/file-tree';
import type { FileRow, ProjectTree } from '@/lib/services/files';

type Target = { kind: 'file' | 'folder'; id: string };
type Mode = 'menu' | 'rename' | 'move' | 'newfolder';
type Editing = Target & { mode: Mode };

const linkBtn = 'btn btn-sm px-2';

// 行內輸入框（改名、新增資料夾共用）；放在元件外，重新渲染時才不會洗掉輸入內容
function NameInput({ initial, label, busy, onSubmit, onCancel }: { initial: string; label: string; busy: boolean; onSubmit: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <form className="flex items-center gap-1 py-1" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}>
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label={label} maxLength={100} className="field mt-0 w-auto min-w-0 flex-1 py-1 text-sm" />
      <button type="submit" disabled={busy} className="btn btn-sm btn-secondary">確定</button>
      <button type="button" onClick={onCancel} className={linkBtn}>取消</button>
    </form>
  );
}

export function FileBrowser({ projectId, title = '專案資料' }: { projectId: string; title?: string }) {
  // null = 還在載入，避免載入中先閃出「還沒有資料」
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/projects/${projectId}`;
  const load = useCallback(() => api<ProjectTree>(`${base}/files`)
    .then((t) => { setTree(t); setError(null); setSelected((s) => (isValidSelection(t.folders, s) ? s : null)); })
    .catch((e) => setError(e.message)), [base]);
  useEffect(() => { void load(); }, [load]);

  const roots = useMemo(() => (tree ? buildTree(tree) : []), [tree]);

  // 所有寫入共用：失敗顯示錯誤，成功重新載入並關掉編輯列
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const json = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const upload = (file: File) => run(async () => {
    const { fileId, signedUrl } = await api<{ fileId: string; signedUrl: string }>(`${base}/files/upload-url`, { method: 'POST' });
    const res = await fetch(signedUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-upsert': 'true' } });
    if (!res.ok) throw new Error(`上傳失敗（${res.status}）`);
    await api(`${base}/files`, json('POST', { fileId, folderId: selected, name: file.name }));
  });
  const createFolder = (name: string, parentId: string | null) => run(() => api(`${base}/folders`, json('POST', { name, parentId })));
  const rename = (t: Target, name: string) => run(() => api(`${base}/${t.kind === 'file' ? 'files' : 'folders'}/${t.id}`, json('PATCH', { name })));
  const move = (t: Target, dest: string) => run(async () => {
    await api(`${base}/${t.kind === 'file' ? 'files' : 'folders'}/${t.id}`,
      json('PATCH', t.kind === 'file' ? { folderId: dest } : { parentId: dest || null }));
    // 展開目的地與它的祖先，搬過去的項目才看得到
    if (dest && tree) setCollapsed((s) => { const n = new Set(s); ancestorFolderIds(tree.folders, dest).forEach((id) => n.delete(id)); return n; });
  });
  const remove = (t: Target, name: string) => {
    const msg = t.kind === 'file' ? `確定要刪除「${name}」？刪除後無法復原。` : `確定要刪除「${name}」和裡面所有檔案？刪除後無法復原。`;
    if (window.confirm(msg)) void run(async () => {
      await api(`${base}/${t.kind === 'file' ? 'files' : 'folders'}/${t.id}`, { method: 'DELETE' });
      if (t.kind === 'folder' && selected && tree && descendantFolderIds(tree.folders, t.id).includes(selected)) setSelected(null);
    });
  };
  const download = async (f: FileRow) => {
    try {
      const { url } = await api<{ url: string; name: string }>(`/api/files/${f.id}/download`);
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const open = (t: Target, mode: Mode) => setEditing({ ...t, mode });
  const isEditing = (t: Target) => (editing?.kind === t.kind && editing.id === t.id ? editing.mode : null);

  // 搬移目的地：排除自己與子孫（檔案則排除目前所在資料夾）
  const movePicker = (t: Target, name: string, currentParent: string | null) => {
    const folders = tree?.folders ?? [];
    const banned = t.kind === 'folder' ? descendantFolderIds(folders, t.id) : [];
    const options = folders.filter((f) => !banned.includes(f.id) && f.id !== currentParent)
      .map((f) => ({ id: f.id, path: folderPath(folders, f.id) })).sort((a, b) => (a.path < b.path ? -1 : 1));
    return (
      <div className="flex items-center gap-1 py-1">
        <select aria-label={`把 ${name} 搬到`} defaultValue="__" onChange={(e) => void move(t, e.target.value)} disabled={busy} className="field mt-0 w-auto min-w-0 flex-1 py-1 text-sm">
          <option value="__" disabled>選擇資料夾…</option>
          {t.kind === 'folder' && currentParent !== null && <option value="">最上層</option>}
          {options.map((o) => <option key={o.id} value={o.id}>{o.path}</option>)}
        </select>
        <button type="button" onClick={() => setEditing(null)} className={linkBtn}>取消</button>
      </div>
    );
  };

  const actions = (t: Target, name: string, parent: string | null) => {
    const mode = isEditing(t);
    if (mode === 'rename') return <NameInput busy={busy} onCancel={() => setEditing(null)} initial={name} label={`新名稱 ${name}`} onSubmit={(v) => void rename(t, v)} />;
    if (mode === 'move') return movePicker(t, name, parent);
    if (mode === 'newfolder') return <NameInput busy={busy} onCancel={() => setEditing(null)} initial="" label={`在 ${name} 裡新增資料夾`} onSubmit={(v) => void createFolder(v, t.id)} />;
    return (
      <>
        {mode === 'menu' && (
          <span className="flex shrink-0 items-center">
            <button disabled={busy} className={linkBtn} aria-label={`改名 ${name}`} onClick={() => open(t, 'rename')}>改名</button>
            <button disabled={busy} className={linkBtn} aria-label={`搬移 ${name}`} onClick={() => open(t, 'move')}>搬移</button>
            {t.kind === 'folder' && <button disabled={busy} className={linkBtn} aria-label={`在 ${name} 裡新增資料夾`} onClick={() => open(t, 'newfolder')}>新增資料夾</button>}
            <button disabled={busy} className={`${linkBtn} text-seal`} aria-label={`刪除 ${name}`} onClick={() => remove(t, name)}>刪除</button>
          </span>
        )}
        <button className={linkBtn} aria-label={`更多 ${name}`} aria-expanded={mode === 'menu'} onClick={() => (mode === 'menu' ? setEditing(null) : open(t, 'menu'))}>⋯</button>
      </>
    );
  };

  const folderNode = (node: TreeNode, depth: number): ReactElement => {
    const { folder } = node;
    const t: Target = { kind: 'folder', id: folder.id };
    const isOpen = !collapsed.has(folder.id);
    const inEdit = isEditing(t) !== null && isEditing(t) !== 'menu';
    return (
      <li key={folder.id}>
        <div className={`flex flex-wrap items-center justify-between gap-x-2 ${selected === folder.id ? 'bg-line/40' : ''}`} style={{ paddingLeft: depth * 12 }}>
          {!inEdit && (
            <button className="flex min-w-0 flex-1 items-center gap-1 py-1.5 text-left font-medium" aria-expanded={isOpen}
              aria-label={`${isOpen ? '收合' : '展開'}資料夾 ${folder.name}`} onClick={() => { toggle(folder.id); setSelected(folder.id); }}>
              <span aria-hidden="true" className="w-3 shrink-0 text-muted">{isOpen ? '▾' : '▸'}</span>
              <span className="truncate" title={folder.name}>{folder.name}</span>
            </button>
          )}
          {actions(t, folder.name, folder.parent_id)}
        </div>
        {isOpen && (
          <ul>
            {node.folders.map((n) => folderNode(n, depth + 1))}
            {node.files.map((f) => fileNode(f, depth + 1))}
            {node.folders.length + node.files.length === 0 && <li className="py-1 text-muted" style={{ paddingLeft: (depth + 1) * 12 + 16 }}>空的</li>}
          </ul>
        )}
      </li>
    );
  };

  const fileNode = (file: FileRow, depth: number) => {
    const t: Target = { kind: 'file', id: file.id };
    const mode = isEditing(t);
    return (
      <li key={file.id} className="flex flex-wrap items-center justify-between gap-x-2" style={{ paddingLeft: depth * 12 + 16 }}>
        {(mode === null || mode === 'menu') && (
          <>
            <span className="flex min-w-0 flex-1 items-baseline gap-2 py-1.5">
              <span className="truncate" title={file.name}>{file.name}</span>
              <span className="shrink-0 text-muted">{formatSize(file.size)}</span>
            </span>
            <button disabled={busy} className={linkBtn} aria-label={`下載 ${file.name}`} onClick={() => void download(file)}>下載</button>
          </>
        )}
        {actions(t, file.name, file.folder_id)}
      </li>
    );
  };

  const newRoot = editing?.kind === 'folder' && editing.id === '' && editing.mode === 'newfolder';
  const selectedName = tree?.folders.find((f) => f.id === selected)?.name;

  return (
    <section aria-labelledby="files-title">
      <h2 id="files-title" className="group-title">{title}</h2>
      <div className="panel p-4">
        <ul className="text-sm">
          {roots.map((n) => folderNode(n, 0))}
          {tree === null && !error && <li className="pb-2 text-muted">載入中…</li>}
          {tree && roots.length === 0 && <li className="pb-2 text-muted">還沒有資料。</li>}
        </ul>
        {newRoot && <NameInput busy={busy} onCancel={() => setEditing(null)} initial="" label="新資料夾名稱" onSubmit={(v) => void createFolder(v, null)} />}
        {error && <p role="alert" className="notice notice-error mt-2">{error}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <FileButton label="上傳檔案" busy={busy} onFile={(f) => void upload(f)} />
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing({ kind: 'folder', id: '', mode: 'newfolder' })}>新增資料夾</button>
        </div>
        <p className="hint mt-2">{selectedName ? `上傳到「${selectedName}」。` : '上傳到「我上傳的」。'}</p>
      </div>
      <p className="hint px-1">上傳後，所有顧問下一次回覆時都讀得到。</p>
    </section>
  );
}
