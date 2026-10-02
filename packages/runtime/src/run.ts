import { createUIMessageStreamResponse, generateId, type LanguageModel, type UIMessageChunk } from 'ai';
import { buildConsultant, buildManager, type BuiltAgent } from './agents/build';
import { createConsultantRunner, type RecordSpeech } from './consultant';
import type { Config } from './config';
import type { Db } from './db';
import { errorText } from './errors';
import { startKeepAlive } from './keepalive';
import { groupSecrets, loadInstances, loadSecrets } from './project-store';
import {
  assertThreadInProject, createRun, finishRun, insertMessage, loadHistory, type RunResult,
} from './run-store';
import { syncSharedFiles, syncSkills } from './sync';
import { consumeToEnd, hasContent, textOf, toolEvents } from './ui-stream';
import { usageRecorder } from './usage';

export const RUN_TIMEOUT_MS = 15 * 60_000;
const TIMEOUT_ERROR = 'run 超過 15 分鐘';
const NO_REPLY_ERROR = '模型沒有產生回覆';

/** runTimeoutMs 只給測試縮短時間用，正式環境一律是 RUN_TIMEOUT_MS */
export type RunDeps = { db: Db; model: LanguageModel; config: Config; runTimeoutMs?: number };

type PreparedRoot = { rootId: string; streamUI: BuiltAgent['streamUI']; close: () => Promise<void> };

async function prepareRootAgent(deps: RunDeps, runId: string, threadId: string): Promise<PreparedRoot> {
  const { db, config, model } = deps;
  const instances = await loadInstances(db, config.PROJECT_ID);
  const consultants = instances.filter((i) => i.role === 'consultant');
  if (consultants.length === 0) throw new Error('專案裡還沒有任何顧問');

  const sharedFiles = await syncSharedFiles(db, config.PROJECT_ID, config.SHARED_ROOT);
  for (const i of consultants) await syncSkills(db, config.AGENTS_ROOT, i);
  const secrets = await loadSecrets(db, config.PROJECT_ID);

  if (consultants.length === 1) {
    const root = consultants[0];
    const built = await buildConsultant({
      db, model, config, instance: root, sharedFiles,
      secrets: groupSecrets(secrets, root.id),
      onStepEnd: usageRecorder({ db, projectId: config.PROJECT_ID, runId, instance: root }),
    });
    return { rootId: root.id, streamUI: built.streamUI, close: built.close };
  }

  const manager = instances.find((i) => i.role === 'manager');
  if (!manager) throw new Error('找不到主管');

  const record: RecordSpeech = async (instance, message, round) => {
    await insertMessage(db, {
      thread_id: threadId,
      run_id: runId,
      speaker_instance_id: instance.id,
      kind: round === null ? 'delegation' : 'discussion',
      round,
      content: textOf(message),
      tool_events: toolEvents(message),
    });
  };
  const built = await buildManager({
    db, model, config, manager, consultants, sharedFiles, record,
    runner: createConsultantRunner({ db, model, config, runId, sharedFiles, secrets }),
    onStepEnd: usageRecorder({ db, projectId: config.PROJECT_ID, runId, instance: manager }),
  });
  return { rootId: manager.id, streamUI: built.streamUI, close: built.close };
}

/** 包住串流，讓 run 逾時時能從上游直接收尾：tee 出去的兩邊（瀏覽器與伺服器）都會結束 */
function stoppable<T>(source: ReadableStream<T>): { stream: ReadableStream<T>; stop: () => void } {
  const reader = source.getReader();
  let stopped = false;
  let controller!: ReadableStreamDefaultController<T>;
  const stream = new ReadableStream<T>({
    start(c) {
      controller = c;
    },
    async pull(c) {
      const { done, value } = await reader.read();
      if (stopped) return;
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(reason) {
      stopped = true;
      return reader.cancel(reason);
    },
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      controller.close();
    } catch {
      // 串流已經結束
    }
    // 不 await：卡住的上游可能永遠不會完成取消
    reader.cancel().catch(() => undefined);
  };
  return { stream, stop };
}

export async function startRun(deps: RunDeps, req: { threadId: string; text: string }): Promise<Response> {
  const { db, config } = deps;
  await assertThreadInProject(db, req.threadId, config.PROJECT_ID);
  const runId = await createRun(db, req.threadId);

  const keepAlive = await startKeepAlive(config.SPRITE_API_SOCK, `run-${runId}`);
  const runTimeoutMs = deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
  // 時間到先通知 agent 中止；工具或串流卡住、中止沒有效果時，再過一段時間強制收尾
  const hardDeadlineMs = runTimeoutMs + Math.min(30_000, runTimeoutMs);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), runTimeoutMs);
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let closeAgent: (() => Promise<void>) | undefined;
  let finished = false;
  const finish = async (result: RunResult) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(hardTimer);
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
    const root = await prepareRootAgent(deps, runId, req.threadId);
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

  const { stream, stop } = stoppable(uiStream);
  const [forClient, forServer] = stream.tee();

  const settle = async (): Promise<RunResult> => {
    const deadline = new Promise<'deadline'>((resolve) => {
      hardTimer = setTimeout(() => resolve('deadline'), hardDeadlineMs);
    });
    const outcome = await Promise.race([consumeToEnd(forServer), deadline]);
    if (outcome === 'deadline') {
      stop();
      return { status: 'failed', error: TIMEOUT_ERROR };
    }
    const { final, failure } = outcome;
    // 串流結束當下就判定是否逾時，不受之後寫入資料庫花的時間影響
    const timedOut = abort.signal.aborted;
    let saveError: string | undefined;
    if (hasContent(final)) {
      await insertMessage(db, {
        thread_id: req.threadId, run_id: runId, speaker_instance_id: rootId, kind: 'final',
        content: textOf(final), ui_message: final, tool_events: toolEvents(final),
      }).catch((e) => { saveError = `無法儲存回覆：${errorText(e)}`; });
    }
    const error = timedOut
      ? TIMEOUT_ERROR
      : failure ?? saveError ?? (hasContent(final) ? undefined : NO_REPLY_ERROR);
    return error ? { status: 'failed', error } : { status: 'succeeded' };
  };

  void (async () => {
    let result: RunResult = { status: 'failed', error: 'run 收尾時發生錯誤' };
    try {
      result = await settle();
    } catch (e) {
      console.error('[run] persist crashed', errorText(e));
      result = { status: 'failed', error: `run 收尾時發生錯誤：${errorText(e)}` };
    } finally {
      // 無論收尾成功與否都要釋放 run，否則這串對話會一直卡在 running
      await finish(result);
    }
  })().catch((e) => console.error('[run] persist crashed', errorText(e)));

  return createUIMessageStreamResponse({ stream: forClient });
}
