import { APIError, type Sprite } from '@fly/sprites';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/http';
import { errorText, forwardChat, installRuntime, isNotFound, retryTransient, runtimeEnvFile, spriteName } from '@/lib/sprites';
import type { Db } from '@/lib/supabase/admin';

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

describe('errorText', () => {
  it('APIError 帶錯誤物件時取出 API 訊息與狀態碼，不顯示 [object Object]', () => {
    const e = new APIError('[object Object]', { statusCode: 500, errorCode: { code: 'internal_error', message: 'Internal server error.' } as never });
    expect(errorText(e)).toBe('Sprites API 500：Internal server error.');
    expect(errorText(new APIError('sprite not found', { statusCode: 404 }))).toBe('Sprites API 404：sprite not found');
    expect(errorText(new Error('一般錯誤'))).toBe('一般錯誤');
    expect(errorText('字串')).toBe('字串');
  });
});

describe('retryTransient', () => {
  it('Sprites API 5xx 時重試，成功就回傳', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new APIError('x', { statusCode: 500 }))
      .mockRejectedValueOnce(new APIError('x', { statusCode: 503 }))
      .mockResolvedValue('ok');
    await expect(retryTransient(fn, 0)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('4xx 與一般錯誤不重試', async () => {
    const notFound = vi.fn().mockRejectedValue(new APIError('nope', { statusCode: 404 }));
    await expect(retryTransient(notFound, 0)).rejects.toThrow('nope');
    expect(notFound).toHaveBeenCalledTimes(1);
    const plain = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(retryTransient(plain, 0)).rejects.toThrow('boom');
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('連續失敗到上限就丟出最後的錯誤', async () => {
    const fn = vi.fn().mockRejectedValue(new APIError('down', { statusCode: 500 }));
    await expect(retryTransient(fn, 0, 3)).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
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

describe('installRuntime', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('建立服務後重新啟動，讓已存在的 Sprite 載入新的 main.js；兩個 log 串流都讀完', async () => {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'VERTEX_API_EXPRESS_MODE_KEY']) vi.stubEnv(k, 'x');
    const calls: string[] = [];
    const logStream = (label: string) => ({ processAll: async () => { calls.push(`${label}:drained`); } });
    const sprite = {
      execFile: async (_cmd: string, args: string[]) => {
        calls.push(args[1].startsWith('printf') ? 'home' : 'download');
        return { stdout: '/home/sprite\n' };
      },
      filesystem: () => ({ writeFile: async (name: string) => { calls.push(`write:${name}`); } }),
      createService: async (name: string, _config: unknown, duration?: string) => {
        calls.push(`create:${name}:${duration}`);
        return logStream('create');
      },
      restartService: async (name: string, duration?: string) => {
        calls.push(`restart:${name}:${duration}`);
        return logStream('restart');
      },
    } as unknown as Sprite;
    const db = {
      storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed' }, error: null }) }) },
    } as unknown as Db;

    expect(await installRuntime(db, sprite, 'p1')).toBe('/home/sprite/agenthub');
    expect(calls).toEqual([
      'home', 'download', 'write:.env',
      'create:runtime:10s', 'create:drained',
      'restart:runtime:10s', 'restart:drained',
    ]);
  });
});
