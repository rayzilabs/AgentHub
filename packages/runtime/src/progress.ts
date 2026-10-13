import type { UIMessage } from 'ai';
import { errorText } from './errors';
import { hasContent } from './ui-stream';

export const PROGRESS_INTERVAL_MS = 5_000;
/** 一個 bash 可能跑 2 分鐘都沒有新快照；心跳讓前端知道 runtime 還活著 */
export const HEARTBEAT_MS = 20_000;

export type ProgressSaver = {
  /** 交給它最新的快照：依間隔節流，有內容才存 */
  offer(m: UIMessage): void;
  /** 停止心跳與接受快照，並等已排入的寫入完成 */
  stop(): Promise<void>;
  /** 是否至少成功存過一次快照 */
  readonly saved: boolean;
};

export function progressSaver(opts: {
  save: (m: UIMessage) => Promise<void>;
  touch: () => Promise<void>;
  intervalMs?: number;
  heartbeatMs?: number;
}): ProgressSaver {
  const intervalMs = opts.intervalMs ?? PROGRESS_INTERVAL_MS;
  let lastSave = -Infinity;
  let saved = false;
  let stopped = false;
  // 所有寫入排成一條鏈，避免較舊的快照晚一步寫入、蓋掉較新的
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>) => {
    chain = chain.then(job).catch((e) => console.error('[run] 無法儲存進度', errorText(e)));
  };
  const heartbeat = setInterval(() => enqueue(opts.touch), opts.heartbeatMs ?? HEARTBEAT_MS);

  return {
    get saved() {
      return saved;
    },
    offer(m) {
      if (stopped || !hasContent(m)) return;
      const now = Date.now();
      if (now - lastSave < intervalMs) return;
      lastSave = now;
      const snapshot = structuredClone(m);
      enqueue(async () => {
        await opts.save(snapshot);
        saved = true;
      });
    },
    async stop() {
      stopped = true;
      clearInterval(heartbeat);
      await chain;
    },
  };
}
