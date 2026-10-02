import { tool, type UIMessage } from 'ai';
import { z } from 'zod';
import type { ConsultantRunner, RecordSpeech } from '../consultant';
import { errorText } from '../errors';
import { SNAPSHOT_INTERVAL_MS, throttle } from '../throttle';
import type { AgentInstance } from '../types';
import { textOf, textOnly, toolEvents, type ToolEvent } from '../ui-stream';

export type DelegationOutput = {
  consultant_id: string;
  name: string;
  status: 'working' | 'done' | 'failed';
  /** 只含文字部分；顧問的工具呼叫細節只以 tools 摘要呈現 */
  message?: UIMessage;
  tools?: ToolEvent[];
  error?: string;
};

type DelegationView = { message: UIMessage; tools: ToolEvent[] };

function viewOf(m: UIMessage): DelegationView {
  return { message: textOnly(m), tools: toolEvents(m) };
}

/** 顧問快照轉成前端看得到的內容，內容沒變就略過 */
async function* changedViews(source: AsyncIterable<UIMessage>, onMessage: (m: UIMessage) => void): AsyncGenerator<DelegationView> {
  let previous: string | undefined;
  for await (const m of source) {
    onMessage(m);
    const view = viewOf(m);
    const key = JSON.stringify(view);
    if (key === previous) continue;
    previous = key;
    yield view;
  }
}

export function assignTaskTool(opts: {
  consultants: AgentInstance[];
  run: ConsultantRunner;
  record: RecordSpeech;
  intervalMs?: number;
}) {
  const byId = new Map(opts.consultants.map((c) => [c.id, c]));
  const ids = opts.consultants.map((c) => c.id) as [string, ...string[]];

  return tool({
    description: '把任務交給一位顧問執行，拿回他的結果。任務說明要寫清楚背景與要交付的內容。',
    inputSchema: z.object({
      consultant_id: z.enum(ids).describe('顧問的 id'),
      task: z.string().min(1).describe('交給顧問的任務說明'),
    }),
    async *execute({ consultant_id, task }, { abortSignal }): AsyncGenerator<DelegationOutput> {
      const instance = byId.get(consultant_id);
      if (!instance) {
        yield { consultant_id, name: consultant_id, status: 'failed', error: '找不到這位顧問' };
        return;
      }
      const base = { consultant_id, name: instance.name };
      let last: UIMessage | undefined;
      const lastView = () => (last ? viewOf(last) : { tools: [] });
      try {
        const views = changedViews(opts.run(instance, task, abortSignal), (m) => (last = m));
        for await (const view of throttle(views, opts.intervalMs ?? SNAPSHOT_INTERVAL_MS)) {
          yield { ...base, status: 'working', ...view };
        }
      } catch (e) {
        yield { ...base, status: 'failed', ...lastView(), error: errorText(e) };
        return;
      }
      if (last) {
        try {
          await opts.record(instance, last, null);
        } catch (e) {
          console.error(`記錄 ${instance.name} 的派工發言失敗：${errorText(e)}`);
        }
      }
      yield { ...base, status: 'done', ...lastView() };
    },
    toModelOutput: ({ output }) =>
      output.status === 'failed'
        ? { type: 'error-text', value: `${output.name} 執行失敗：${output.error}` }
        : { type: 'text', value: textOf(output.message) || '（顧問沒有回覆內容）' },
  });
}
