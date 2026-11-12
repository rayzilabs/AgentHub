import type { FileRow, FolderRow, ProjectTree } from '@/lib/services/files';

/** 每個專案根層的上傳資料夾（client 與 server 共用） */
export const UPLOAD_FOLDER_NAME = '我上傳的';

export type TreeNode = { folder: FolderRow; folders: TreeNode[]; files: FileRow[] };

export const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** 根層資料夾，「我上傳的」排第一，其餘依名稱 */
export function buildTree({ folders, files }: ProjectTree): TreeNode[] {
  const nodes = new Map<string, TreeNode>(folders.map((f) => [f.id, { folder: f, folders: [], files: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.folder.parent_id ? nodes.get(node.folder.parent_id) : undefined;
    (parent ? parent.folders : roots).push(node);
  }
  for (const f of files) nodes.get(f.folder_id)?.files.push(f);
  // 不用 localeCompare：結果隨執行環境的 ICU 而變，順序要固定
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => byName(a.folder, b.folder));
    for (const n of list) { n.files.sort(byName); sort(n.folders); }
  };
  sort(roots);
  roots.sort((a, b) => Number(b.folder.name === UPLOAD_FOLDER_NAME) - Number(a.folder.name === UPLOAD_FOLDER_NAME));
  return roots;
}

/** 'ETF 資金流顧問/2026-W43' */
export function folderPath(folders: FolderRow[], id: string): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  for (let cur = byId.get(id), guard = 0; cur && guard < 100; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined, guard++) {
    parts.unshift(cur.name);
  }
  return parts.join('/');
}

/** 含自己；搬移選單用來排除 */
export function descendantFolderIds(folders: FolderRow[], id: string): string[] {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) {
    for (const f of folders) if (f.parent_id === ids[i]) ids.push(f.id);
  }
  return ids;
}

/** 含自己，由內往外；搬移後用來展開目的地 */
export function ancestorFolderIds(folders: FolderRow[], id: string): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const ids: string[] = [];
  for (let cur = byId.get(id); cur && !ids.includes(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) ids.push(cur.id);
  return ids;
}

