import type { UIMessage } from 'ai';
import type { QueuedView, RunStatus } from '@/lib/services/threads';

export const ALREADY_READ = '這則訊息已被讀取';

/**
 * 這輪結束時排隊訊息怎麼處理：正常完成時伺服器會自己開下一輪；其他情況不自動再花額度，放回輸入框。
 * stopWanted：使用者按了停止，就算這輪剛好正常完成也不再等下一輪。
 */
export function afterRun(
  data: { running: boolean; runStatus: RunStatus | null; queued: QueuedView[] },
  stopWanted = false,
): 'none' | 'wait' | 'restore' {
  if (data.queued.length === 0) return 'none';
  if (data.running) return 'wait';
  return data.runStatus === 'succeeded' && !stopWanted ? 'wait' : 'restore';
}

/** 串流還開著：這輪結束時 onFinish 會接手，不用另外看伺服器 */
export function chatInFlight(status: string): boolean {
  return status === 'submitted' || status === 'streaming';
}

/** 先從伺服器刪掉，回傳該放回輸入框的訊息。已被 agent 讀走的不放回，否則同一段文字會同時出現在回覆和輸入框 */
export async function reclaimQueued(items: QueuedView[], del: (id: string) => Promise<unknown>): Promise<QueuedView[]> {
  const kept = await Promise.all(items.map(async (item) => {
    try {
      await del(item.id);
      return item;
    } catch (e) {
      return (e as Error).message === ALREADY_READ ? null : item;
    }
  }));
  return kept.filter((item) => item !== null);
}

export function restoredInput(current: string, queued: QueuedView[]): string {
  return [current, ...queued.map((q) => q.text)].filter(Boolean).join('\n\n');
}

/** 已被 agent 讀到的排隊訊息 id */
export function readIds(messages: UIMessage[]): Set<string> {
  return new Set(messages.flatMap((m) => m.parts.flatMap((p) => (
    p.type === 'data-interjection' ? [(p as { data: { id: string } }).data.id] : []
  ))));
}
