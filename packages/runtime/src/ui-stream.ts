import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { errorText } from './errors';

export type StreamOutcome = { final: UIMessage | undefined; failure: string | undefined };

export function textOf(m: UIMessage | undefined): string {
  if (!m) return '';
  return m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

export function toolEvents(m: UIMessage): { tool: string; state: string }[] {
  return m.parts.flatMap((p) => {
    if (p.type === 'dynamic-tool') return [{ tool: p.toolName, state: p.state }];
    if (p.type.startsWith('tool-')) return [{ tool: p.type.slice('tool-'.length), state: (p as { state: string }).state }];
    return [];
  });
}

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

export async function consumeToEnd(stream: ReadableStream<UIMessageChunk>): Promise<StreamOutcome> {
  const it = readSnapshots(stream);
  let r = await it.next();
  while (!r.done) r = await it.next();
  return r.value;
}
