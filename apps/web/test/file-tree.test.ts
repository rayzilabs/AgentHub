import { describe, expect, it } from 'vitest';
import { buildTree, descendantFolderIds, folderPath, formatSize } from '@/lib/file-tree';
import type { FileRow, FolderRow, ProjectTree } from '@/lib/services/files';

const folder = (id: string, name: string, parent_id: string | null = null): FolderRow => ({ id, name, parent_id });
const file = (id: string, folder_id: string, name: string): FileRow => ({
  id, folder_id, name, size: 1, content_type: 'text/plain', source: 'user', agent_instance_id: null, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z',
});

const tree: ProjectTree = {
  folders: [
    folder('etf', 'ETF 資金流顧問'),
    folder('up', '我上傳的'),
    folder('w43', '2026-W43', 'etf'),
    folder('w43a', '圖表', 'w43'),
    folder('bond', '債券顧問'),
  ],
  files: [file('f1', 'up', 'a.txt'), file('f2', 'w43', '週報.docx'), file('f3', 'w43', '週報.md')],
};

describe('file-tree', () => {
  it('buildTree 把「我上傳的」排第一、子資料夾與檔案掛對位置', () => {
    const roots = buildTree(tree);
    expect(roots.map((n) => n.folder.name)).toEqual(['我上傳的', 'ETF 資金流顧問', '債券顧問']);
    expect(roots[0].files.map((f) => f.id)).toEqual(['f1']);
    const w43 = roots[1].folders[0];
    expect(w43.folder.name).toBe('2026-W43');
    expect(w43.files.map((f) => f.id)).toEqual(['f2', 'f3']);
    expect(w43.folders[0].folder.id).toBe('w43a');
  });

  it('folderPath 組出完整路徑', () => {
    expect(folderPath(tree.folders, 'w43')).toBe('ETF 資金流顧問/2026-W43');
    expect(folderPath(tree.folders, 'etf')).toBe('ETF 資金流顧問');
  });

  it('descendantFolderIds 含自己與所有子孫', () => {
    expect(descendantFolderIds(tree.folders, 'etf').sort()).toEqual(['etf', 'w43', 'w43a']);
    expect(descendantFolderIds(tree.folders, 'bond')).toEqual(['bond']);
  });

  it('formatSize', () => {
    expect(formatSize(100)).toBe('1 KB');
    expect(formatSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
