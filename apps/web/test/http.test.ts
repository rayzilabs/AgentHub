import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpError, readJson, route } from '@/lib/http';

const req = (body?: string) => new Request('http://x/api', { method: 'POST', body });

describe('route', () => {
  it('回傳物件時轉成 JSON', async () => {
    const res = await route(async () => ({ a: 1 }))(req(), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('HttpError 轉成對應狀態碼與訊息', async () => {
    const res = await route(async () => { throw new HttpError(404, '找不到這個專案'); })(req(), {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '找不到這個專案' });
  });

  it('ZodError 轉成 400 並帶第一個問題', async () => {
    const res = await route(async (r) => readJson(r, z.object({ name: z.string().min(1, '請填寫名稱') })))(req('{"name":""}'), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '請填寫名稱' });
  });

  it('不是 JSON 時回 400', async () => {
    const res = await route(async (r) => readJson(r, z.object({})))(req('not json'), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '請求內容不是有效的 JSON' });
  });

  it('其他錯誤回 500，不洩漏內部訊息', async () => {
    const res = await route(async () => { throw new Error('db password wrong'); })(req(), {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: '伺服器發生錯誤，請稍後再試' });
  });

  it('回傳 Response 時原樣送出', async () => {
    const res = await route(async () => new Response('raw', { status: 201 }))(req(), {});
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('raw');
  });
});
