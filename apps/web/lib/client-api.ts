export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (e) {
    // fetch 只有在連不上伺服器時丟 TypeError；取消請求等其他錯誤原樣往上丟
    if (e instanceof TypeError) throw new Error('網路連線中斷，請稍後再試');
    throw e;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `請求失敗（${res.status}）`);
  return body as T;
}
