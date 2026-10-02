import {
  createUIMessageStreamResponse, generateId, readUIMessageStream,
  type LanguageModel, type UIMessage, type UIMessageChunk,
} from 'ai';
import { buildConsultant, type BuiltAgent } from './agents/build';
import type { Config } from './config';
import type { Db } from './db';
import { errorText } from './errors';
import { startKeepAlive } from './keepalive';
import { groupSecrets, loadInstances, loadSecrets } from './project-store';
import {
  assertThreadInProject, createRun, finishRun, insertMessage, loadHistory, type RunResult,
} from './run-store';
import { syncSharedFiles, syncSkills } from './sync';
import { usageRecorder } from './usage';

export const RUN_TIMEOUT_MS = 15 * 60_000;

export type RunDeps = { db: Db; model: LanguageModel; config: Config };

type PreparedRoot = { rootId: string; streamUI: BuiltAgent['streamUI']; close: () => Promise<void> };

export function textOf(m: UIMessage): string {
  return m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

export function toolEvents(m: UIMessage): { tool: string; state: string }[] {
  return m.parts.flatMap((p) => {
    if (p.type === 'dynamic-tool') return [{ tool: p.toolName, state: p.state }];
    if (p.type.startsWith('tool-')) return [{ tool: p.type.slice('tool-'.length), state: (p as { state: string }).state }];
    return [];
  });
}

function hasContent(m: UIMessage | undefined): m is UIMessage {
  return !!m && m.parts.some((p) => p.type === 'text' || p.type === 'dynamic-tool' || p.type.startsWith('tool-'));
}

async function prepareRootAgent(deps: RunDeps, runId: string): Promise<PreparedRoot> {
  const { db, config, model } = deps;
  const instances = await loadInstances(db, config.PROJECT_ID);
  const consultants = instances.filter((i) => i.role === 'consultant');
  if (consultants.length === 0) throw new Error('專案裡還沒有任何顧問');
  if (consultants.length > 1) throw new Error('多顧問模式尚未實作');

  const sharedFiles = await syncSharedFiles(db, config.PROJECT_ID, config.SHARED_ROOT);
  for (const i of consultants) await syncSkills(db, config.AGENTS_ROOT, i);
  const secrets = await loadSecrets(db, config.PROJECT_ID);

  const root = consultants[0];
  const built = await buildConsultant({
    db, model, config, instance: root, sharedFiles,
    secrets: groupSecrets(secrets, root.id),
    onStepEnd: usageRecorder({ db, projectId: config.PROJECT_ID, runId, instance: root }),
  });
  return { rootId: root.id, streamUI: built.streamUI, close: built.close };
}

async function consumeToEnd(
  stream: ReadableStream<UIMessageChunk>,
): Promise<{ final: UIMessage | undefined; failure: string | undefined }> {
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
    for await (const m of readUIMessageStream({ stream: watched })) final = m;
  } catch (e) {
    failure ??= errorText(e);
  }
  return { final, failure };
}

export async function startRun(deps: RunDeps, req: { threadId: string; text: string }): Promise<Response> {
  const { db, config } = deps;
  await assertThreadInProject(db, req.threadId, config.PROJECT_ID);
  const runId = await createRun(db, req.threadId);

  const keepAlive = await startKeepAlive(config.SPRITE_API_SOCK, `run-${runId}`);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);
  let closeAgent: (() => Promise<void>) | undefined;
  const finish = async (result: RunResult) => {
    clearTimeout(timer);
    await closeAgent?.().catch(() => undefined);
    await finishRun(db, runId, result).catch((e) => console.error('[run] 無法更新 run 狀態', errorText(e)));
    await keepAlive.stop();
  };

  let uiStream: ReadableStream<UIMessageChunk>;
  let rootId: string;
  try {
    const history = await loadHistory(db, req.threadId);
    await insertMessage(db, {
      thread_id: req.threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: req.text,
      ui_message: { id: generateId(), role: 'user', parts: [{ type: 'text', text: req.text }] },
    });
    const root = await prepareRootAgent(deps, runId);
    closeAgent = root.close;
    rootId = root.rootId;
    uiStream = await root.streamUI({
      messages: [...history, { role: 'user', content: req.text }],
      abortSignal: abort.signal,
    });
  } catch (e) {
    await finish({ status: 'failed', error: errorText(e) });
    throw e;
  }

  const [forClient, forServer] = uiStream.tee();
  void (async () => {
    const { final, failure } = await consumeToEnd(forServer);
    let saveError: string | undefined;
    if (hasContent(final)) {
      await insertMessage(db, {
        thread_id: req.threadId, run_id: runId, speaker_instance_id: rootId, kind: 'final',
        content: textOf(final), ui_message: final, tool_events: toolEvents(final),
      }).catch((e) => { saveError = `無法儲存回覆：${errorText(e)}`; });
    }
    const error = failure ?? saveError ?? (abort.signal.aborted ? 'run 超過 15 分鐘' : undefined);
    await finish(error ? { status: 'failed', error } : { status: 'succeeded' });
  })();

  return createUIMessageStreamResponse({ stream: forClient });
}
