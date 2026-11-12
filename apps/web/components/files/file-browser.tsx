'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { FileButton } from '@/components/file-button';
import { api, uploadToSignedUrl } from '@/lib/client-api';
import { ancestorFolderIds, buildTree, descendantFolderIds, folderPath, formatSize, UPLOAD_FOLDER_NAME, type TreeNode } from '@/lib/file-tree';
import type { FileRow, ProjectTree } from '@/lib/services/files';

type Target = { kind: 'file' | 'folder'; id: string };
type Mode = 'menu' | 'rename' | 'move' | 'newfolder';
type Editing = Target & { mode: Mode };

const linkBtn = 'btn btn-sm px-2';
const menuItem = 'block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-sunken focus-visible:bg-sunken focus-visible:outline-none disabled:opacity-50';
const INDENT = 14;

// 行內輸入框（改名、新增資料夾共用）；放在元件外，重新渲染時才不會洗掉輸入內容
function NameInput({ initial, label, busy, onSubmit, onCancel }: { initial: string; label: string; busy: boolean; onSubmit: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <form className="flex min-w-0 flex-1 items-center gap-1 py-1" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}>
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
        onFocus={(e) => e.target.select()} aria-label={label} maxLength={100} className="field mt-0 w-auto min-w-0 flex-1 py-1 text-sm" />
      <button type="submit" disabled={busy || !value.trim()} className="btn btn-sm btn-secondary px-3">確定</button>
      <button type="button" onClick={onCancel} className={linkBtn}>取消</button>
    </form>
  );
}

// ⋯ 展開的浮動選單：點外面或按 Esc 關閉，關閉時焦點回到 ⋯
function ActionMenu({ name, onClose, children }: { name: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = ref.current?.parentElement?.querySelector<HTMLButtonElement>('button[aria-haspopup]');
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onDown = (e: PointerEvent) => { if (!ref.current?.parentElement?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); trigger?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div ref={ref} role="group" aria-label={`${name} 的動作`}
      className="absolute right-0 top-full z-20 mt-1 w-40 rounded-xl border border-line bg-surface p-1 shadow-lg">
      {children}
    </div>
  );
}

export function FileBrowser({ projectId, title = '專案資料' }: { projectId: string; title?: string }) {
  // null = 還在載入，避免載入中先閃出「還沒有資料」
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 剛上傳／新增／搬過去的項目短暫標亮，讓人知道東西放到哪了
  const [flash, setFlash] = useState<string | null>(null);
  // 同一頁可能掛多個 FileBrowser（我的雲端），標題 id 必須唯一
  const titleId = useId();
  // 選單裡的「上傳到這裡」共用一個隱藏的檔案欄位，目的地先記在這裡
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadDest = useRef<string | null>(null);

  const base = `/api/projects/${projectId}`;
  const load = useCallback(() => api<ProjectTree>(`${base}/files`)
    .then((t) => { setTree(t); setError(null); })
    .catch((e) => setError(e.message)), [base]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const roots = useMemo(() => (tree ? buildTree(tree) : []), [tree]);
  const closeEditing = useCallback(() => setEditing(null), []);

  // 展開某個資料夾和它的祖先，裡面的項目才看得到
  const reveal = (folderId: string | null, folders = tree?.folders ?? []) => {
    if (folderId) setCollapsed((s) => { const n = new Set(s); ancestorFolderIds(folders, folderId).forEach((id) => n.delete(id)); return n; });
  };

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

  const upload = async (file: File, folderId: string | null) => {
    setUploading(true);
    await run(async () => {
      const { fileId, signedUrl } = await api<{ fileId: string; signedUrl: string }>(`${base}/files/upload-url`, { method: 'POST' });
      await uploadToSignedUrl(signedUrl, file, file.type || 'application/octet-stream');
      const row = await api<FileRow>(`${base}/files`, { method: 'POST', json: { fileId, folderId, name: file.name } });
      reveal(row.folder_id);
      setFlash(row.id);
    });
    setUploading(false);
  };
  const createFolder = (name: string, parentId: string | null) => run(async () => {
    const row = await api<{ id: string }>(`${base}/folders`, { method: 'POST', json: { name, parentId } });
    reveal(parentId);
    setFlash(row.id);
  });
  const rename = (t: Target, name: string) => run(() => api(`${base}/${t.kind === 'file' ? 'files' : 'folders'}/${t.id}`, { method: 'PATCH', json: { name } }));
  const move = (t: Target, dest: string) => run(async () => {
    await api(`${base}/${t.kind === 'file' ? 'files' : 'folders'}/${t.id}`,
      { method: 'PATCH', json: t.kind === 'file' ? { folderId: dest } : { parentId: dest || null } });
    reveal(dest || null);
    setFlash(t.id);
  });
  const remove = (t: Target, name: string) => {
    setEditing(null);
    const msg = t.kind === 'file' ? `確定要刪除「${name}」？刪除後無法復原。` : `確定要刪除「${name}」和裡面所有檔案？刪除後無法復原。`;
    if (window.confirm(msg)) void run(() => api(`${base}/${t.kind === 'file' ? 'files' : 'folders'}/${t.id}`, { method: 'DELETE' }));
  };
  const download = async (f: FileRow) => {
    setEditing(null);
    try {
      const { url } = await api<{ url: string; name: string }>(`/api/files/${f.id}/download`);
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const pickUpload = (folderId: string) => {
    setEditing(null);
    uploadDest.current = folderId;
    fileInput.current?.click();
  };

  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const open = (t: Target, mode: Mode) => {
    setEditing({ ...t, mode });
    // 在資料夾裡新增時先展開它，輸入框才會出現在裡面
    if (mode === 'newfolder' && t.kind === 'folder') setCollapsed((s) => { const n = new Set(s); n.delete(t.id); return n; });
  };
  const isEditing = (t: Target) => (editing?.kind === t.kind && editing.id === t.id ? editing.mode : null);

  // 搬移目的地：排除自己與子孫（檔案則排除目前所在資料夾）
  const movePicker = (t: Target, name: string, currentParent: string | null, depth: number) => {
    const folders = tree?.folders ?? [];
    const banned = t.kind === 'folder' ? descendantFolderIds(folders, t.id) : [];
    const options = folders.filter((f) => !banned.includes(f.id) && f.id !== currentParent)
      .map((f) => ({ id: f.id, path: folderPath(folders, f.id) })).sort((a, b) => (a.path < b.path ? -1 : 1));
    const canRoot = t.kind === 'folder' && currentParent !== null;
    return (
      <div className="my-1 rounded-xl bg-sunken px-2.5 py-2" style={{ marginLeft: depth * INDENT }}>
        <p className="mb-1 truncate text-xs text-muted">把「{name}」搬到</p>
        {options.length === 0 && !canRoot ? (
          <p className="text-sm text-muted">沒有其他資料夾可以搬過去。</p>
        ) : (
          <select autoFocus aria-label={`把 ${name} 搬到`} defaultValue="__" onChange={(e) => void move(t, e.target.value)} disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} className="field mt-0 py-1 text-sm">
            <option value="__" disabled>選擇資料夾…</option>
            {canRoot && <option value="">最上層</option>}
            {options.map((o) => <option key={o.id} value={o.id}>{o.path}</option>)}
          </select>
        )}
        <div className="mt-1 flex justify-end">
          <button type="button" onClick={() => setEditing(null)} className={linkBtn}>取消</button>
        </div>
      </div>
    );
  };

  // ⋯ 按鈕與它的選單
  const more = (t: Target, name: string, items: ReactNode) => {
    const isOpen = isEditing(t) === 'menu';
    return (
      <div className="relative shrink-0">
        <button className={`${linkBtn} text-muted ${isOpen ? 'bg-sunken' : ''}`} aria-label={`更多 ${name}`} aria-haspopup="true" aria-expanded={isOpen}
          onClick={() => (isOpen ? setEditing(null) : open(t, 'menu'))}>⋯</button>
        {isOpen && <ActionMenu name={name} onClose={closeEditing}>{items}</ActionMenu>}
      </div>
    );
  };
  const commonItems = (t: Target, name: string) => (
    <>
      <button disabled={busy} className={menuItem} onClick={() => open(t, 'rename')}>改名</button>
      <button disabled={busy} className={menuItem} onClick={() => open(t, 'move')}>搬移到…</button>
      <div className="my-1 border-t border-line" />
      <button disabled={busy} className={`${menuItem} text-seal`} onClick={() => remove(t, name)}>刪除</button>
    </>
  );

  const rowClass = (id: string, active: boolean) =>
    `flex items-center gap-1 rounded-lg transition-colors duration-700 ${flash === id ? 'bg-brand-soft' : active ? 'bg-sunken' : 'hover:bg-sunken/60'}`;

  const folderNode = (node: TreeNode, depth: number): ReactElement => {
    const { folder } = node;
    const t: Target = { kind: 'folder', id: folder.id };
    const mode = isEditing(t);
    const isOpen = !collapsed.has(folder.id);
    const empty = node.folders.length + node.files.length === 0;
    return (
      <li key={folder.id}>
        <div className={rowClass(folder.id, mode !== null)} style={{ paddingLeft: depth * INDENT }}>
          {mode === 'rename' ? (
            <NameInput busy={busy} onCancel={closeEditing} initial={folder.name} label={`新名稱 ${folder.name}`} onSubmit={(v) => void rename(t, v)} />
          ) : (
            <>
              <button className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-1 text-left font-medium" aria-expanded={isOpen}
                aria-label={`${isOpen ? '收合' : '展開'}資料夾 ${folder.name}`} onClick={() => toggle(folder.id)}>
                <span aria-hidden="true" className="w-3 shrink-0 text-center text-xs text-muted">{isOpen ? '▾' : '▸'}</span>
                <span className="truncate" title={folder.name}>{folder.name}</span>
              </button>
              {more(t, folder.name, (
                <>
                  <button disabled={busy} className={menuItem} onClick={() => pickUpload(folder.id)}>上傳檔案到這裡</button>
                  <button disabled={busy} className={menuItem} onClick={() => open(t, 'newfolder')}>新增子資料夾</button>
                  {commonItems(t, folder.name)}
                </>
              ))}
            </>
          )}
        </div>
        {mode === 'move' && movePicker(t, folder.name, folder.parent_id, depth)}
        {isOpen && (
          <ul>
            {mode === 'newfolder' && (
              <li className="flex" style={{ paddingLeft: (depth + 1) * INDENT }}>
                <NameInput busy={busy} onCancel={closeEditing} initial="" label={`在 ${folder.name} 裡新增資料夾`} onSubmit={(v) => void createFolder(v, folder.id)} />
              </li>
            )}
            {node.folders.map((n) => folderNode(n, depth + 1))}
            {node.files.map((f) => fileNode(f, depth + 1))}
            {empty && mode !== 'newfolder' && <li className="py-1 text-muted" style={{ paddingLeft: (depth + 1) * INDENT + 22 }}>空的</li>}
          </ul>
        )}
      </li>
    );
  };

  const fileNode = (file: FileRow, depth: number) => {
    const t: Target = { kind: 'file', id: file.id };
    const mode = isEditing(t);
    return (
      <li key={file.id}>
        <div className={rowClass(file.id, mode !== null)} style={{ paddingLeft: depth * INDENT + 22 }}>
          {mode === 'rename' ? (
            <NameInput busy={busy} onCancel={closeEditing} initial={file.name} label={`新名稱 ${file.name}`} onSubmit={(v) => void rename(t, v)} />
          ) : (
            <>
              <button disabled={busy} className="flex min-w-0 flex-1 items-baseline gap-2 py-1.5 text-left" title={`下載 ${file.name}`}
                aria-label={`下載 ${file.name}`} onClick={() => void download(file)}>
                <span className="truncate">{file.name}</span>
                <span className="shrink-0 text-xs text-muted">{formatSize(file.size)}</span>
              </button>
              {more(t, file.name, (
                <>
                  <button disabled={busy} className={menuItem} onClick={() => void download(file)}>下載</button>
                  {commonItems(t, file.name)}
                </>
              ))}
            </>
          )}
        </div>
        {mode === 'move' && movePicker(t, file.name, file.folder_id, depth)}
      </li>
    );
  };

  const newRoot = editing?.kind === 'folder' && editing.id === '' && editing.mode === 'newfolder';

  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId} className="group-title">{title}</h2>
      <div className="panel p-3">
        <ul className="text-sm">
          {roots.map((n) => folderNode(n, 0))}
          {tree === null && !error && <li className="px-1 pb-2 text-muted">載入中…</li>}
          {tree && roots.length === 0 && <li className="px-1 pb-2 text-muted">還沒有資料。</li>}
          {newRoot && (
            <li className="flex">
              <NameInput busy={busy} onCancel={closeEditing} initial="" label="新資料夾名稱" onSubmit={(v) => void createFolder(v, null)} />
            </li>
          )}
        </ul>
        {error && <p role="alert" className="notice notice-error mt-2">{error}</p>}
        <input ref={fileInput} type="file" className="hidden" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f, uploadDest.current); e.target.value = ''; }} />
        <div className="mt-3 flex flex-wrap items-center gap-2 px-1">
          <FileButton label="上傳檔案" busy={busy} uploading={uploading} onFile={(f) => void upload(f, null)} />
          <button disabled={busy} className="btn btn-secondary btn-sm" onClick={() => setEditing({ kind: 'folder', id: '', mode: 'newfolder' })}>新增資料夾</button>
        </div>
        <p className="hint mt-2 px-1">會放進「{UPLOAD_FOLDER_NAME}」。要放到其他資料夾，從資料夾的 ⋯ 選「上傳檔案到這裡」。</p>
      </div>
      <p className="hint px-1">上傳後，所有顧問下一次回覆時都讀得到。</p>
    </section>
  );
}
