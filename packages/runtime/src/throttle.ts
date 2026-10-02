export const SNAPSHOT_INTERVAL_MS = 200;

export async function* throttle<T>(source: AsyncIterable<T>, intervalMs = SNAPSHOT_INTERVAL_MS): AsyncGenerator<T> {
  let lastEmit = 0;
  let pending: { value: T } | undefined;
  for await (const value of source) {
    const now = Date.now();
    if (now - lastEmit >= intervalMs) {
      lastEmit = now;
      pending = undefined;
      yield structuredClone(value);
    } else {
      pending = { value };
    }
  }
  if (pending) yield structuredClone(pending.value);
}
