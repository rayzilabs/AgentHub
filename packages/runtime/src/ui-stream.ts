import { generateId, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { errorText } from './errors';
import { truncate } from './tools/bash';

export type StreamOutcome = { final: UIMessage | undefined; failure: string | undefined };

export function textOf(m: UIMessage | undefined): string {
  if (!m) return '';
  return m.parts.flatMap((p) => (p.type === 'text' && p.text ? [p.text] : [])).join('\n\n');
}

/** 只保留文字部分的訊息（工具輸出裡不放顧問的工具呼叫，避免串流與存下來的 ui_message 過大） */
export function textOnly(m: UIMessage): UIMessage {
  return { id: m.id, role: m.role, parts: m.parts.filter((p) => p.type === 'text') };
}

/** 每次工具呼叫的開始與結束時間，存在 UIMessage 的 metadata.tool_times（見 tool-clock.ts） */
export type ToolTimes = Record<string, { started_at: string; ended_at?: string }>;

/** 給前端看的工具摘要：不含原始輸入與輸出（web 端 lib/agent-output.ts 有一份相同的型別） */
export type ToolEvent = { tool: string; state: string; description?: string; started_at?: string; ended_at?: string };

/** 只寫進 messages.tool_events 的完整紀錄，事後除錯用 */
export type ToolRecord = ToolEvent & { tool_call_id: string; input?: string; output?: string };

export const RECORD_TEXT_MAX = 2_000;

type ToolPartLike = {
  type: string;
  toolName?: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function toolParts(m: UIMessage): ToolPartLike[] {
  return m.parts.filter((p) => p.type === 'dynamic-tool' || p.type.startsWith('tool-')) as unknown as ToolPartLike[];
}

function toolTimesOf(m: UIMessage): ToolTimes {
  return (m.metadata as { tool_times?: ToolTimes } | undefined)?.tool_times ?? {};
}

function eventOf(p: ToolPartLike, times: ToolTimes): ToolEvent {
  const tool = p.type === 'dynamic-tool' ? p.toolName ?? 'tool' : p.type.slice('tool-'.length);
  const description = (p.input as { description?: unknown } | undefined)?.description;
  const t = times[p.toolCallId];
  return {
    tool,
    state: p.state,
    ...(typeof description === 'string' && description ? { description } : {}),
    ...(t?.started_at ? { started_at: t.started_at } : {}),
    ...(t?.ended_at ? { ended_at: t.ended_at } : {}),
  };
}

export function toolEvents(m: UIMessage): ToolEvent[] {
  const times = toolTimesOf(m);
  return toolParts(m).map((p) => eventOf(p, times));
}

/** 顧問用 deliver_file 交付的檔案（web 端 lib/agent-output.ts 有一份相同的型別）；folder 是從根目錄起的路徑 */
export type DeliveredFile = { file_id: string; name: string; folder: string; size: number };

export function deliveredFiles(m: UIMessage): DeliveredFile[] {
  return toolParts(m).flatMap((p) => {
    if (p.type !== 'tool-deliver_file' || p.state !== 'output-available') return [];
    const o = p.output as Partial<DeliveredFile> | undefined;
    if (!o || typeof o.file_id !== 'string') return [];
    return [{ file_id: o.file_id, name: String(o.name), folder: String(o.folder), size: Number(o.size) }];
  });
}

const clip = (v: unknown): string => truncate(typeof v === 'string' ? v : JSON.stringify(v), RECORD_TEXT_MAX);

export function toolRecords(m: UIMessage): ToolRecord[] {
  const times = toolTimesOf(m);
  return toolParts(m).map((p) => {
    const output = p.state === 'output-error' ? p.errorText ?? '' : p.output;
    return {
      ...eventOf(p, times),
      tool_call_id: p.toolCallId,
      ...(p.input !== undefined ? { input: clip(p.input) } : {}),
      ...(output !== undefined ? { output: clip(output) } : {}),
    };
  });
}

/** 有沒有任何值得存下來的內容（文字、工具紀錄、已取走的插話）；算不算有回覆要看 textOf */
export function hasContent(m: UIMessage | undefined): m is UIMessage {
  return !!m && m.parts.some((p) => p.type === 'text' || p.type === 'data-interjection' || p.type === 'dynamic-tool' || p.type.startsWith('tool-'));
}

/** 被使用者中斷時給下一輪看的進度：只有步驟描述與已寫出的文字，不含工具輸入輸出 */
export function interruptedProgress(m: UIMessage | undefined): string {
  if (!m) return '';
  const events = toolEvents(m);
  const names = (states: string[]) => events.filter((e) => states.includes(e.state)).map((e) => e.description ?? e.tool);
  const done = names(['output-available']);
  const running = names(['input-streaming', 'input-available']);
  return [
    done.length ? `已完成的步驟：${done.join('；')}` : '',
    running.length ? `中斷時正在進行：${running.join('；')}` : '',
    textOf(m),
  ].filter(Boolean).join('\n\n');
}

/** 補上「已由你中斷」的標記；還沒有任何內容時新建一則訊息，畫面才有地方顯示 */
export function interruptedMessage(m: UIMessage | undefined): UIMessage {
  const base: UIMessage = m ?? { id: generateId(), role: 'assistant', parts: [] };
  return { ...base, parts: [...base.parts, { type: 'data-interrupted', data: {} }] };
}

export async function* readSnapshots(
  stream: ReadableStream<UIMessageChunk>,
): AsyncGenerator<UIMessage, StreamOutcome> {
  let failure: string | undefined;
  const watched = stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'error') failure = chunk.errorText;
        if (chunk.type === 'abort') failure ??= 'run 已中止';
        controller.enqueue(chunk);
      },
    }),
  );
  let final: UIMessage | undefined;
  try {
    for await (const m of readUIMessageStream({ stream: watched })) {
      final = m;
      yield m;
    }
  } catch (e) {
    failure ??= errorText(e);
  }
  return { final, failure };
}

export async function consumeToEnd(
  stream: ReadableStream<UIMessageChunk>,
  onSnapshot?: (m: UIMessage) => void,
): Promise<StreamOutcome> {
  const it = readSnapshots(stream);
  let r = await it.next();
  while (!r.done) {
    onSnapshot?.(r.value);
    r = await it.next();
  }
  return r.value;
}
