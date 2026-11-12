/** 呼叫平台 API；json 會序列化成請求本文 */
export async function api<T>(path: string, { json, ...init }: RequestInit & { json?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (e) {
    throw networkError(e);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `請求失敗（${res.status}）`);
  return body as T;
}

/** fetch 只有在連不上伺服器時丟 TypeError；取消請求等其他錯誤原樣往上丟 */
function networkError(e: unknown): unknown {
  return e instanceof TypeError ? new Error('網路連線中斷，請稍後再試') : e;
}

/** 用 Storage 簽名網址直接上傳；hint 接在失敗訊息後面，說明接下來怎麼做 */
export async function uploadToSignedUrl(url: string, file: File, contentType: string, hint = ''): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'PUT', body: file, headers: { 'content-type': contentType, 'x-upsert': 'true' } });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw new Error(`上傳失敗（${res.status}）${hint}`);
}
