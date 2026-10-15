import type { HostedVersionView } from '@/lib/services/hosted-mcp';

export const POLL_MS = 5000;
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;

const LABELS: Record<string, string> = {
  pending: '等待上傳',
  deploying: '部署中',
  ready: '部署成功，尚未發布',
  failed: '部署失敗',
  published: '已發布',
  retired: '已下架',
  disabled: '已被平台停用',
};

export function statusLabel(status: string): string {
  return LABELS[status] ?? status;
}

export function statusChip(status: string): '' | 'chip-sage' | 'chip-seal' | 'chip-brand' {
  if (status === 'published') return 'chip-sage';
  if (status === 'failed' || status === 'disabled') return 'chip-seal';
  if (status === 'deploying') return 'chip-brand';
  return '';
}

export function canPublish(v: Pick<HostedVersionView, 'status'>): boolean {
  return v.status === 'ready';
}

export function canRetire(v: Pick<HostedVersionView, 'status' | 'projects'>): boolean {
  return ['pending', 'ready', 'failed', 'published'].includes(v.status) && v.projects === 0;
}

/** 需要每 5 秒更新的版本 id（部署中） */
export function pollingIds(versions: Pick<HostedVersionView, 'id' | 'status'>[]): string[] {
  return versions.filter((v) => v.status === 'deploying').map((v) => v.id);
}

/** 對每個 id 發一次讀取；同一個 id 上一次還沒回來就跳過（讀取會推進部署，可能遠超過 5 秒） */
export function pollOnce(ids: string[], inFlight: Set<string>, fetchOne: (id: string) => Promise<unknown>): void {
  for (const id of ids) {
    if (inFlight.has(id)) continue;
    inFlight.add(id);
    const done = () => { inFlight.delete(id); };
    fetchOne(id).then(done, done);
  }
}

/** 頁面列出的版本：不含已下架，新的在前 */
export function visibleVersions<T extends Pick<HostedVersionView, 'status' | 'version'>>(versions: T[]): T[] {
  return versions.filter((v) => v.status !== 'retired').sort((a, b) => b.version - a.version);
}

/** 建立版本之前就擋下，免得留下沒用的「等待上傳」版本 */
export function zipProblem(file: { name: string; size: number }): string | null {
  if (!/\.zip$/i.test(file.name)) return '請上傳 .zip 檔';
  if (file.size === 0) return '檔案是空的';
  if (file.size > MAX_ZIP_BYTES) return '套件超過 50 MB';
  return null;
}

/** 略過名稱或值空白的列：空白的值不能覆寫既有金鑰 */
export function secretRowsToSave(rows: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (key && r.value) out[key] = r.value;
  }
  return out;
}
