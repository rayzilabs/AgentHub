import { tool, type UIMessage } from 'ai';
import { z } from 'zod';
import type { ConsultantRunner, RecordSpeech } from '../consultant';
import { errorText } from '../errors';
import { SNAPSHOT_INTERVAL_MS, throttle } from '../throttle';
import type { AgentInstance } from '../types';
import { textOf } from '../ui-stream';

export type DelegationOutput = {
  consultant_id: string;
  name: string;
  status: 'working' | 'done' | 'failed';
  message?: UIMessage;
  error?: string;
};

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
      try {
        for await (const message of throttle(opts.run(instance, task, abortSignal), opts.intervalMs ?? SNAPSHOT_INTERVAL_MS)) {
          last = message;
          yield { ...base, status: 'working', message };
        }
        if (last) await opts.record(instance, last, null);
        yield { ...base, status: 'done', message: last };
      } catch (e) {
        yield { ...base, status: 'failed', message: last, error: errorText(e) };
      }
    },
    toModelOutput: ({ output }) =>
      output.status === 'failed'
        ? { type: 'error-text', value: `${output.name} 執行失敗：${output.error}` }
        : { type: 'text', value: textOf(output.message) || '（顧問沒有回覆內容）' },
  });
}
