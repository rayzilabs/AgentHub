import type { UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { consumeToEnd, hasContent, readSnapshots, textOf, textOnly, toolEvents, toolRecords } from '../src/ui-stream';

function chunks(list: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const c of list) controller.enqueue(c);
      controller.close();
    },
  });
}

const textChunks: UIMessageChunk[] = [
  { type: 'start', messageId: 'm1' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: '你' },
  { type: 'text-delta', id: 't1', delta: '好' },
  { type: 'text-end', id: 't1' },
  { type: 'finish' },
];

describe('ui-stream', () => {
  it('readSnapshots 逐步產生快照，最後回傳完整訊息', async () => {
    const it = readSnapshots(chunks(textChunks));
    const seen: string[] = [];
    let r = await it.next();
    while (!r.done) {
      seen.push(textOf(r.value));
      r = await it.next();
    }
    expect(seen.at(-1)).toBe('你好');
    expect(r.value.failure).toBeUndefined();
    expect(textOf(r.value.final)).toBe('你好');
  });

  it('error chunk 會變成 failure', async () => {
    const outcome = await consumeToEnd(chunks([
      { type: 'start', messageId: 'm1' },
      { type: 'error', errorText: '模型掛了' },
    ]));
    expect(outcome.failure).toBe('模型掛了');
  });

  it('textOf / toolEvents / hasContent', () => {
    const m = {
      id: 'x',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'A' },
        { type: 'tool-write_file', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
        { type: 'text', text: 'B' },
      ],
    } as unknown as UIMessage;
    expect(textOf(m)).toBe('A\n\nB');
    expect(textOf(undefined)).toBe('');
    expect(toolEvents(m)).toEqual([{ tool: 'write_file', state: 'output-available' }]);
    expect(hasContent(m)).toBe(true);
    expect(hasContent({ id: 'y', role: 'assistant', parts: [] } as UIMessage)).toBe(false);
    expect(hasContent(undefined)).toBe(false);
  });

  it('toolEvents 帶出 description 與 metadata 裡的時間', () => {
    const m = {
      id: 'x',
      role: 'assistant',
      metadata: { tool_times: { c1: { started_at: '2026-10-13T00:00:00.000Z', ended_at: '2026-10-13T00:00:12.000Z' } } },
      parts: [
        { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: { command: 'python a.py', description: '計算評等' }, output: { exitCode: 0, output: 'ok', timedOut: false } },
        { type: 'tool-bash', toolCallId: 'c2', state: 'input-available', input: { command: 'ls' } },
      ],
    } as unknown as UIMessage;
    expect(toolEvents(m)).toEqual([
      { tool: 'bash', state: 'output-available', description: '計算評等', started_at: '2026-10-13T00:00:00.000Z', ended_at: '2026-10-13T00:00:12.000Z' },
      { tool: 'bash', state: 'input-available' },
    ]);
  });

  it('toolRecords 另外帶 tool_call_id、截短的輸入與輸出；錯誤時輸出是錯誤訊息', () => {
    const m = {
      id: 'x',
      role: 'assistant',
      parts: [
        { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: { command: 'cat big' }, output: { output: 'x'.repeat(5000) } },
        { type: 'tool-bash', toolCallId: 'c2', state: 'output-error', input: { command: 'boom' }, errorText: '指令失敗' },
        { type: 'tool-bash', toolCallId: 'c3', state: 'input-streaming' },
      ],
    } as unknown as UIMessage;
    const [a, b, c] = toolRecords(m);
    expect(a).toMatchObject({ tool: 'bash', state: 'output-available', tool_call_id: 'c1', input: '{"command":"cat big"}' });
    expect(a.output!.length).toBeLessThan(2_100);
    expect(a.output).toContain('已截斷');
    expect(b).toMatchObject({ tool_call_id: 'c2', input: '{"command":"boom"}', output: '指令失敗' });
    expect(c).toEqual({ tool: 'bash', state: 'input-streaming', tool_call_id: 'c3' });
  });

  it('textOnly 只留文字部分', () => {
    const m = {
      id: 'x',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'A' },
        { type: 'tool-write_file', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
        { type: 'dynamic-tool', toolName: 'mcp__x', toolCallId: 'c2', state: 'input-available', input: {} },
        { type: 'text', text: 'B' },
      ],
    } as unknown as UIMessage;
    expect(textOnly(m)).toEqual({ id: 'x', role: 'assistant', parts: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] });
  });
});
