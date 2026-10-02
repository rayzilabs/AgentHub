export class RunConflictError extends Error {}
export class NotFoundError extends Error {}
export class SyncError extends Error {}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
