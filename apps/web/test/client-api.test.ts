import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/client-api';

afterEach(() => { vi.unstubAllGlobals(); });

describe('api', () => {
  it('伺服器回 { error } 時丟出那段訊息', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: '找不到這個專案' }, { status: 404 }));
    await expect(api('/api/x')).rejects.toThrow('找不到這個專案');
  });

  it('網路中斷（fetch 丟 TypeError）時丟出中文訊息', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await expect(api('/api/x')).rejects.toThrow('網路連線中斷，請稍後再試');
  });

  it('其他錯誤（例如取消請求）原樣丟出', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', async () => { throw abort; });
    await expect(api('/api/x')).rejects.toBe(abort);
  });
});
