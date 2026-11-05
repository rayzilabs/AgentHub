import type { UIMessage } from 'ai';
import type { QueuedView, RunStatus } from '@/lib/services/threads';

/** 這輪結束時排隊訊息怎麼處理：正常完成時伺服器會自己開下一輪；其他情況不自動再花額度，放回輸入框 */
export function afterRun(data: { running: boolean; runStatus: RunStatus | null; queued: QueuedView[] }): 'none' | 'wait' | 'restore' {
  if (data.queued.length === 0) return 'none';
  return data.running || data.runStatus === 'succeeded' ? 'wait' : 'restore';
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
