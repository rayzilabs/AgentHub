import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
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

/** 有沒有任何值得存下來的內容（文字或工具紀錄）；算不算有回覆要看 textOf */
export function hasContent(m: UIMessage | undefined): m is UIMessage {
  return !!m && m.parts.some((p) => p.type === 'text' || p.type === 'dynamic-tool' || p.type.startsWith('tool-'));
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
