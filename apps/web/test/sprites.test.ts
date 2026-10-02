import { APIError } from '@fly/sprites';
import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import { forwardChat, isNotFound, runtimeEnvFile, spriteName } from '@/lib/sprites';

const body = { thread_id: 't1', text: '你好' };

function fakeFetch(steps: Array<'refuse' | number>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = steps[calls.length - 1];
    if (step === 'refuse') throw new TypeError('fetch failed: ECONNREFUSED');
    return new Response('stream', { status: step });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('spriteName / runtimeEnvFile', () => {
  it('Sprite 名稱帶前綴；env 檔每行 KEY="value"', () => {
    expect(spriteName('abc')).toBe('agenthub-abc');
    expect(runtimeEnvFile({ A: 'x', B: 'has "quote"' })).toBe('A="x"\nB="has \\"quote\\""\n');
  });
});

describe('isNotFound', () => {
  it('依 API 狀態碼判斷，不因訊息裡的 404（例如 UUID）誤判', () => {
    expect(isNotFound(new APIError('sprite not found', { statusCode: 404 }))).toBe(true);
    expect(isNotFound(new APIError('agenthub-1404abcd 刪除失敗', { statusCode: 500 }))).toBe(false);
    expect(isNotFound(new APIError('not found upstream', { statusCode: 502 }))).toBe(false);
    expect(isNotFound(new Error('agenthub-0404-aaaa failed'))).toBe(false);
    expect(isNotFound(new Error('Sprite not found'))).toBe(true);
    expect(isNotFound(new Error('notfound'))).toBe(false);
  });
});

describe('forwardChat', () => {
  it('送到 /chat，帶 Bearer token 與 JSON body', async () => {
    const { impl, calls } = fakeFetch([200]);
    const res = await forwardChat('https://s.example', body, { token: 'tok', fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://s.example/chat');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(calls[0].init.body).toBe(JSON.stringify(body));
  });

  it('連線被拒或 502/503/504 時重試', async () => {
    const { impl, calls } = fakeFetch(['refuse', 503, 200]);
    const res = await forwardChat('https://s.example', body, { token: 't', fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('409 等其他狀態碼不重試，原樣回傳', async () => {
    const { impl, calls } = fakeFetch([409]);
    const res = await forwardChat('https://s.example', body, { token: 't', fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('三次都失敗：502', async () => {
    const { impl } = fakeFetch(['refuse', 'refuse', 'refuse']);
    const e = await forwardChat('https://s.example', body, { token: 't', fetchImpl: impl, retryDelayMs: 0 }).catch((err) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(502);
    expect(e.message).toContain('agent 環境無法連線');
  });
});
