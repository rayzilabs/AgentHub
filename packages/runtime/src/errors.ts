export class RunConflictError extends Error {}
export class NotFoundError extends Error {}
export class SyncError extends Error {}
/** 顧問超過 RunClock.consultantStopAt 被強制停止 */
export class ConsultantStoppedError extends Error {}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
