import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { withToolTimes } from '../src/tool-clock';
import { toolEvents } from '../src/ui-stream';

function chunks(list: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const c of list) controller.enqueue(c);
      controller.close();
    },
  });
}

/** 依序回傳指定的時間，用完之後一直回傳最後一個 */
function clock(...times: string[]) {
  let i = 0;
  return () => new Date(times[Math.min(i++, times.length - 1)]);
}

async function lastMessage(stream: ReadableStream<UIMessageChunk>): Promise<UIMessage> {
  let last: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream })) last = m;
  return last!;
}

const T0 = '2026-10-13T00:00:00.000Z';
const T1 = '2026-10-13T00:00:12.000Z';

describe('withToolTimes', () => {
  it('記下開始與結束時間；preliminary 輸出不算結束', async () => {
    const stream = withToolTimes(chunks([
      { type: 'start', messageId: 'm1' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'bash' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls', description: '列出檔案' } },
      { type: 'tool-output-available', toolCallId: 'c1', output: { partial: true }, preliminary: true },
      { type: 'tool-output-available', toolCallId: 'c1', output: { done: true } },
      { type: 'finish' },
    ]), clock(T0, T1));
    const m = await lastMessage(stream);
    expect(m.metadata).toEqual({ tool_times: { c1: { started_at: T0, ended_at: T1 } } });
    expect(toolEvents(m)).toEqual([{ tool: 'bash', state: 'output-available', description: '列出檔案', started_at: T0, ended_at: T1 }]);
  });

  it('沒有 tool-input-start 時從 tool-input-available 開始計時；tool-output-error 也算結束', async () => {
    const stream = withToolTimes(chunks([
      { type: 'start', messageId: 'm1' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'bash', input: { command: 'boom' } },
      { type: 'tool-output-error', toolCallId: 'c1', errorText: '失敗' },
      { type: 'finish' },
    ]), clock(T0, T1));
    const m = await lastMessage(stream);
    expect(m.metadata).toEqual({ tool_times: { c1: { started_at: T0, ended_at: T1 } } });
  });

  it('沒有工具呼叫：不送 message-metadata', async () => {
    const out: UIMessageChunk[] = [];
    const stream = withToolTimes(chunks([
      { type: 'start', messageId: 'm1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '你好' },
      { type: 'text-end', id: 't1' },
      { type: 'finish' },
    ]));
    for await (const c of stream) out.push(c);
    expect(out.some((c) => c.type === 'message-metadata')).toBe(false);
  });
});
