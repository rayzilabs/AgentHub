import { tool, type UIMessage } from 'ai';
import { z } from 'zod';
import type { ConsultantRunner, RecordSpeech } from '../consultant';
import { ConsultantStoppedError, errorText } from '../errors';
import { TIME_UP } from '../run-clock';
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
  /** 時間預算：wrap-up = 過了收尾時間才完成；stopped = 逾時被強制停止 */
  cutoff?: 'wrap-up' | 'stopped';
};

export const STOPPED_ERROR = '逾時，只交回部分結果';

/** 顧問被強制停止時交給主管的內容：已完成的步驟與已寫出的文字 */
export function stoppedSummary(o: DelegationOutput): string {
  const steps = (o.tools ?? []).filter((t) => t.state === 'output-available').map((t) => t.description ?? t.tool);
  return `${o.name} 逾時，只完成部分工作。已完成的步驟：${steps.length ? steps.join('；') : '無'}。已寫出的內容：${textOf(o.message) || '無'}`;
}

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
  /** 過了這個時間就不再啟動顧問（RunClock.consultantWrapUpAt） */
  acceptUntil?: number;
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
      if (opts.acceptUntil !== undefined && Date.now() >= opts.acceptUntil) {
        yield { consultant_id, name: instance.name, status: 'failed', error: TIME_UP };
        return;
      }
      const base = { consultant_id, name: instance.name };
      let last: UIMessage | undefined;
      const lastView = () => (last ? viewOf(last) : { tools: [] });
      // 顧問只要產生過內容，不論成功或失敗都記錄下來，事後查得到它做了哪些步驟
      const save = async () => {
        if (!last) return;
        try {
          await opts.record(instance, last, null);
        } catch (e) {
          console.error(`記錄 ${instance.name} 的派工發言失敗：${errorText(e)}`);
        }
      };
      try {
        const views = changedViews(opts.run(instance, task, abortSignal), (m) => (last = m));
        for await (const view of throttle(views, opts.intervalMs ?? SNAPSHOT_INTERVAL_MS)) {
          yield { ...base, status: 'working', ...view };
        }
      } catch (e) {
        await save();
        if (e instanceof ConsultantStoppedError) {
          yield { ...base, status: 'failed', cutoff: 'stopped', ...lastView(), error: STOPPED_ERROR };
        } else {
          yield { ...base, status: 'failed', ...lastView(), error: errorText(e) };
        }
        return;
      }
      await save();
      const wrappedUp = opts.acceptUntil !== undefined && Date.now() >= opts.acceptUntil;
      yield { ...base, status: 'done', ...(wrappedUp ? { cutoff: 'wrap-up' as const } : {}), ...lastView() };
    },
    toModelOutput: ({ output }) => {
      if (output.cutoff === 'stopped') return { type: 'text', value: stoppedSummary(output) };
      return output.status === 'failed'
        ? { type: 'error-text', value: `${output.name} 執行失敗：${output.error}` }
        : { type: 'text', value: textOf(output.message) || '（顧問沒有回覆內容）' };
    },
  });
}
