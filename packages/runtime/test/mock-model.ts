import { APICallError } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

/** Vertex 忙線（共用容量塞車）時回的錯誤；標成不可重試，測試才不用等 AI SDK 退避重試 */
export function quotaError() {
  return new APICallError({
    message: 'Resource exhausted. Please try again later.', url: 'https://platform/api/runtime/model', requestBodyValues: {}, statusCode: 429, isRetryable: false,
  });
}

export const usage = {
  inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: 0 },
  outputTokens: { total: 5, text: 4, reasoning: 1 },
};

type Turn = { stream: ReadableStream<any> };

export function textTurn(text: string, chunkDelayInMs?: number): Turn {
  const pieces = chunkDelayInMs ? Array.from(text) : [text];
  return {
    stream: simulateReadableStream({
      chunkDelayInMs,
      chunks: [
        { type: 'text-start', id: 't1' },
        ...pieces.map((delta) => ({ type: 'text-delta', id: 't1', delta })),
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ],
    }),
  };
}

export function toolTurn(toolName: string, input: unknown, toolCallId = 'call-1'): Turn {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
      ],
    }),
  };
}

/** 只有 finish，沒有任何文字或工具呼叫 */
export function emptyTurn(): Turn {
  return {
    stream: simulateReadableStream({
      chunks: [{ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }],
    }),
  };
}

/** 先吐出一段文字，接著串流中途出錯 */
export function errorAfterTextTurn(text: string, message: string): Turn {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'error', error: new Error(message) },
      ],
    }),
  };
}

/** 吐出一段文字後就停住，不結束也不理會中止 */
export function hangAfterTextTurn(text: string): Turn {
  return {
    stream: new ReadableStream({
      start(c) {
        c.enqueue({ type: 'text-start', id: 't1' });
        c.enqueue({ type: 'text-delta', id: 't1', delta: text });
      },
    }),
  };
}

export function mockModel(...turns: Turn[]) {
  return new MockLanguageModelV4({ doStream: turns });
}

/** 和 mockModel 相同，但第 n 次呼叫前先跑 before[n]，用來在指定的步驟之間排隊訊息 */
export function steppedModel(turns: Turn[], before: Record<number, () => PromiseLike<unknown>>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const n = call++;
      await before[n]?.();
      return turns[n];
    },
  });
}

export function failingModel(message: string) {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new Error(message);
    },
  });
}

/** 模型呼叫永遠不回應，也不理會中止訊號（模擬卡住的模型或工具，只能靠硬性時限收尾） */
export function hangingModel() {
  return new MockLanguageModelV4({ doStream: () => new Promise(() => {}) });
}

export function promptText(model: MockLanguageModelV4, call = 0): string {
  return JSON.stringify(model.doStreamCalls[call].prompt);
}
