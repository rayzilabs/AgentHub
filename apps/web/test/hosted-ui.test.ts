import { describe, expect, it } from 'vitest';
import {
  canPublish, canRetire, MAX_ZIP_BYTES, pollOnce, pollingIds, secretRowsToSave, statusChip, statusLabel, visibleVersions, zipProblem,
} from '@/lib/hosted-ui';

describe('代管區塊', () => {
  it('狀態文字與顏色', () => {
    expect(statusLabel('pending')).toBe('等待上傳');
    expect(statusLabel('deploying')).toBe('部署中');
    expect(statusLabel('ready')).toBe('部署成功，尚未發布');
    expect(statusLabel('failed')).toBe('部署失敗');
    expect(statusLabel('published')).toBe('已發布');
    expect(statusLabel('disabled')).toBe('已被平台停用');
    expect(statusLabel('weird')).toBe('weird');
    expect(statusChip('published')).toBe('chip-sage');
    expect(statusChip('failed')).toBe('chip-seal');
    expect(statusChip('disabled')).toBe('chip-seal');
    expect(statusChip('deploying')).toBe('chip-brand');
    expect(statusChip('pending')).toBe('');
  });

  it('只有部署成功的能發布；沒有專案在用、且不是部署中或停用的才能下架', () => {
    expect(canPublish({ status: 'ready' })).toBe(true);
    expect(canPublish({ status: 'published' })).toBe(false);
    for (const status of ['pending', 'ready', 'failed', 'published']) expect(canRetire({ status, projects: 0 })).toBe(true);
    expect(canRetire({ status: 'published', projects: 2 })).toBe(false);
    for (const status of ['deploying', 'retired', 'disabled']) expect(canRetire({ status, projects: 0 })).toBe(false);
  });

  it('離開頁面再回來時，部署中的版本要繼續更新', () => {
    expect(pollingIds([{ id: 'a', status: 'published' }, { id: 'b', status: 'deploying' }, { id: 'c', status: 'pending' }])).toEqual(['b']);
    expect(pollingIds([])).toEqual([]);
  });

  it('列表不含已下架，新的在前', () => {
    const vs = [{ version: 1, status: 'retired' }, { version: 3, status: 'ready' }, { version: 2, status: 'published' }];
    expect(visibleVersions(vs).map((v) => v.version)).toEqual([3, 2]);
  });

  it('zip 檢查在建立版本之前擋下', () => {
    expect(zipProblem({ name: 'mcp.zip', size: 1000 })).toBeNull();
    expect(zipProblem({ name: 'MCP.ZIP', size: MAX_ZIP_BYTES })).toBeNull();
    expect(zipProblem({ name: 'mcp.tar.gz', size: 1000 })).toBe('請上傳 .zip 檔');
    expect(zipProblem({ name: 'mcp.zip', size: MAX_ZIP_BYTES + 1 })).toBe('套件超過 50 MB');
    expect(zipProblem({ name: 'mcp.zip', size: 0 })).toBe('檔案是空的');
  });

  it('金鑰表單：略過空白列，不會把既有金鑰覆寫成空值', () => {
    expect(secretRowsToSave([
      { key: ' API_KEY ', value: 'v' }, { key: 'EMPTY', value: '' }, { key: '', value: 'orphan' }, { key: 'B', value: 'b' },
    ])).toEqual({ API_KEY: 'v', B: 'b' });
  });

  it('輪詢：同一個版本前一次還沒回來就跳過，不會疊請求', async () => {
    const inFlight = new Set<string>();
    const calls: string[] = [];
    let finish: () => void = () => {};
    const fetchOne = (id: string) => { calls.push(id); return new Promise<void>((r) => { finish = r; }); };
    pollOnce(['a'], inFlight, fetchOne);
    pollOnce(['a'], inFlight, fetchOne);
    expect(calls).toEqual(['a']);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    pollOnce(['a'], inFlight, fetchOne);
    expect(calls).toEqual(['a', 'a']);
  });

  it('輪詢失敗也會放行下一輪', async () => {
    const inFlight = new Set<string>();
    let n = 0;
    pollOnce(['a'], inFlight, () => { n++; return Promise.reject(new Error('x')); });
    await new Promise((r) => setTimeout(r, 0));
    pollOnce(['a'], inFlight, () => { n++; return Promise.resolve(); });
    expect(n).toBe(2);
  });
});
