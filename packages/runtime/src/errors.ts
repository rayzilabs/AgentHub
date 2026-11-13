export class RunConflictError extends Error {}
export class NotFoundError extends Error {}
export class SyncError extends Error {}
/** 顧問超過 RunClock.consultantStopAt 被強制停止 */
export class ConsultantStoppedError extends Error {}

/** 使用者按停止時的中止原因，用來和逾時分開 */
export const USER_STOP = 'user-stop';

export function isUserStop(signal?: AbortSignal): boolean {
  return signal?.reason === USER_STOP;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const BUSY_ERROR = '目前使用人數較多，請稍後再試。';

/** 模型配額用完（Vertex 429／RESOURCE_EXHAUSTED），重試後仍失敗；RetryError 的原因在 errors 裡 */
export function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const x = e as { statusCode?: unknown; message?: unknown; errors?: unknown };
  if (x.statusCode === 429) return true;
  if (typeof x.message === 'string' && /resource[ _]exhausted/i.test(x.message)) return true;
  return Array.isArray(x.errors) && x.errors.some(isQuotaError);
}

/** 串流錯誤交給使用者與主管看的文字：配額用完時換成可理解的說明，原始錯誤留在 log */
export function modelErrorText(e: unknown): string {
  if (!isQuotaError(e)) return errorText(e);
  console.warn('[model] 配額用完', errorText(e));
  return BUSY_ERROR;
}
