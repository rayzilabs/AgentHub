import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function route<C>(handler: (req: Request, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const result = await handler(req, ctx);
      if (result instanceof Response) return result;
      return Response.json(result ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof ZodError) {
        return Response.json({ error: e.issues[0]?.message ?? '請求格式錯誤' }, { status: 400 });
      }
      console.error('[api]', e);
      return Response.json({ error: '伺服器發生錯誤，請稍後再試' }, { status: 500 });
    }
  };
}

const HOP_BY_HOP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive', 'content-encoding']);

/** 轉送上游回應時要帶回去的標頭（去掉逐跳標頭） */
export function upstreamHeaders(h: Headers): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k)) out.set(k, v);
  });
  return out;
}

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, '請求內容不是有效的 JSON');
  }
  return schema.parse(body);
}
