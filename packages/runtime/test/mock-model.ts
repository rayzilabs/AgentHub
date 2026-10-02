import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

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

export function mockModel(...turns: Turn[]) {
  return new MockLanguageModelV4({ doStream: turns });
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
