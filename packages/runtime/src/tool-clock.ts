import type { UIMessageChunk } from 'ai';
import type { ToolTimes } from './ui-stream';

/**
 * 在 UI 串流裡記下每次工具呼叫的開始與結束時間，以 message-metadata 送出。
 * 每次都送完整的 tool_times，不依賴 metadata 的合併行為；串流、存檔、輪詢讀回來的訊息都帶有時間。
 */
export function withToolTimes(
  stream: ReadableStream<UIMessageChunk>,
  now: () => Date = () => new Date(),
): ReadableStream<UIMessageChunk> {
  const times: ToolTimes = {};
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        let changed = false;
        if ((chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available') && !times[chunk.toolCallId]) {
          times[chunk.toolCallId] = { started_at: now().toISOString() };
          changed = true;
        }
        const ended =
          (chunk.type === 'tool-output-available' && !chunk.preliminary) ||
          chunk.type === 'tool-output-error' ||
          chunk.type === 'tool-input-error' ||
          chunk.type === 'tool-output-denied';
        if (ended) {
          const t = (times[chunk.toolCallId] ??= { started_at: now().toISOString() });
          if (!t.ended_at) {
            t.ended_at = now().toISOString();
            changed = true;
          }
        }
        if (changed) controller.enqueue({ type: 'message-metadata', messageMetadata: { tool_times: structuredClone(times) } });
      },
    }),
  );
}
