import type { ModelMessage, UIMessageChunk } from 'ai';
import type { Db } from './db';
import { errorText } from './errors';
import { insertMessage, takeQueued, type QueuedMessage } from './run-store';

export type Inbox = {
  /** 取走排隊訊息、寫 interjection 列，回傳要放進下一步的訊息。失敗只記 log，回 [] */
  take(): Promise<ModelMessage[]>;
  /** 把取走的訊息以 data-interjection 插在下一個 start-step 之前 */
  pipe(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk>;
};

const INTERJECTION_PREFIX = '使用者在你工作途中補充：\n';

export function createInbox(opts: { db: Db; threadId: string; runId: string }): Inbox {
  const { db, threadId, runId } = opts;
  let unsent: QueuedMessage[] = [];
  const sendUnsent = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
    for (const { id, text } of unsent) controller.enqueue({ type: 'data-interjection', id, data: { id, text } });
    unsent = [];
  };

  return {
    async take() {
      let queued: QueuedMessage[];
      try {
        queued = await takeQueued(db, threadId);
      } catch (e) {
        console.error('[inbox] 無法讀取排隊訊息', errorText(e));
        return [];
      }
      for (const { text } of queued) {
        // 排隊列已經刪掉，就算紀錄寫失敗也要交給模型，否則這則訊息就遺失了
        await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'interjection', content: text })
          .catch((e) => console.error('[inbox] 無法記錄插話', errorText(e)));
      }
      unsent.push(...queued);
      return queued.map(({ text }) => ({ role: 'user', content: `${INTERJECTION_PREFIX}${text}` }));
    },
    pipe(stream) {
      return stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          if (chunk.type === 'start-step') sendUnsent(controller);
          controller.enqueue(chunk);
        },
        flush: sendUnsent,
      }));
    },
  };
}

/** 每一步開始前讀排隊訊息；messages 覆寫會延續到後續步驟，所以只附加這一次 */
export function withInbox<T extends object>(prepare: (o: { stepNumber: number }) => T, inbox?: Inbox) {
  return async (o: { stepNumber: number; messages: ModelMessage[] }) => {
    const base = prepare(o);
    const extra = (await inbox?.take()) ?? [];
    return extra.length ? { ...base, messages: [...o.messages, ...extra] } : base;
  };
}
