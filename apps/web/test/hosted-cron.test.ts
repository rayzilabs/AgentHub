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
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); hoisted.calls.length = 0; });

  it('沒設定 CRON_SECRET：503，不執行', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect((await call('Bearer x')).status).toBe(503);
    expect(hoisted.calls).toEqual([]);
  });

  it('密鑰不對或沒帶：401，不執行；印出原因但不印密鑰', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await call('Bearer wrong')).status).toBe(401);
    expect((await call()).status).toBe(401);
    expect(hoisted.calls).toEqual([]);
    const printed = warn.mock.calls.map((c) => c.join(' '));
    expect(printed).toEqual(['[cron] hosted-cleanup 拒絕：密鑰不符', '[cron] hosted-cleanup 拒絕：沒有帶密鑰']);
    expect(printed.join()).not.toContain('right-secret');
  });

  it('正確的密鑰：清理失敗版本的 Sprite 與孤兒套件', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await call('Bearer right-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sprites: ['agenthub-mcp-a'], bundles: ['x/fin/1.zip'] });
    expect(hoisted.calls).toEqual(['cleanupFailed', 'removeOrphanBundles']);
    // Vercel 的 Runtime Logs 只列出有輸出的請求：每次執行都印一行結果
    expect(log.mock.calls.map((c) => c.join(' '))).toEqual(['[cron] hosted-cleanup 完成：刪除 Sprite 1 台（agenthub-mcp-a）、套件 1 個']);
  });
});
