import { afterEach, describe, expect, it, vi } from 'vitest';

// 清理函式是全域操作，測試打正式資料庫：這裡只驗證身分檢查與接線，不真的清
const hoisted = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/lib/services/hosted-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/hosted-mcp')>()),
  cleanupFailed: async () => { hoisted.calls.push('cleanupFailed'); return ['agenthub-mcp-a']; },
  removeOrphanBundles: async () => { hoisted.calls.push('removeOrphanBundles'); return ['x/fin/1.zip']; },
}));
vi.mock('@/lib/hosted-sprite', () => ({ createHostedSpriteOps: () => ({}) }));

const { GET } = await import('@/app/api/cron/hosted-cleanup/route');
const call = (auth?: string) => GET(new Request('https://p.test/api/cron/hosted-cleanup', { headers: auth ? { authorization: auth } : {} }), {});

describe('排程：清理代管 MCP', () => {
  afterEach(() => { vi.unstubAllEnvs(); hoisted.calls.length = 0; });

  it('沒設定 CRON_SECRET：503，不執行', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect((await call('Bearer x')).status).toBe(503);
    expect(hoisted.calls).toEqual([]);
  });

  it('密鑰不對或沒帶：401，不執行', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret');
    expect((await call('Bearer wrong')).status).toBe(401);
    expect((await call()).status).toBe(401);
    expect(hoisted.calls).toEqual([]);
  });

  it('正確的密鑰：清理失敗版本的 Sprite 與孤兒套件', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret');
    const res = await call('Bearer right-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sprites: ['agenthub-mcp-a'], bundles: ['x/fin/1.zip'] });
    expect(hoisted.calls).toEqual(['cleanupFailed', 'removeOrphanBundles']);
  });
});
