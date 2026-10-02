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

export function promptText(model: MockLanguageModelV4, call = 0): string {
  return JSON.stringify(model.doStreamCalls[call].prompt);
}
