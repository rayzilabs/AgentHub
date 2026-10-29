import { createUIMessageStreamResponse, generateId, type LanguageModel, type UIMessage, type UIMessageChunk } from 'ai';
import { buildConsultant, buildManager, type BuiltAgent, type PlatformGateway } from './agents/build';
import { createConsultantRunner, type RecordSpeech } from './consultant';
import type { Config } from './config';
import type { Db } from './db';
import { errorText } from './errors';
import { startKeepAlive } from './keepalive';
import { groupSecrets, loadInstances, loadSecrets } from './project-store';
import { progressSaver, PROGRESS_INTERVAL_MS } from './progress';
import { createRunClock, type RunClock } from './run-clock';
import { ensureConsultantSandboxes } from './sandbox';
import {
  assertThreadInProject, createRun, deleteMessage, failRunningRuns, finishRun, insertMessage, loadHistory, touchMessage, updateMessage,
  type RunResult,
} from './run-store';
import { syncSharedFiles, syncSkills } from './sync';
import { consumeToEnd, hasContent, textOf, toolRecords } from './ui-stream';
import { usageRecorder } from './usage';

export const RUN_TIMEOUT_MS = 15 * 60_000;
const TIMEOUT_ERROR = 'run 超過 15 分鐘';
const NO_REPLY_ERROR = '模型沒有產生回覆';

/** runTimeoutMs、progressIntervalMs 只給測試縮短時間用，正式環境一律用預設值 */
export type RunDeps = {
  /** 用 Vercel 附上的 runtime 帳號通行證開這次 run 的資料庫連線 */
  openDb: (dbToken: string) => Db;
  /** 模型經平台代理呼叫，用專案通行證驗證 */
  modelFor: (platformToken: string | undefined) => LanguageModel;
  config: Config;
  runTimeoutMs?: number;
  progressIntervalMs?: number;
};

type ActiveDeps = Omit<RunDeps, 'openDb' | 'modelFor'> & { db: Db; model: LanguageModel };

// 每個程序在第一次 run 前清一次上個程序遺留的 running run（開機時沒有通行證，無法在開機時清）。
// 在本程序建立任何 run 之前完成，所以不會誤清自己的 run。以 deps 為 key，每個 app 各自一份。
const orphanCleanups = new WeakMap<RunDeps, Promise<void>>();

function cleanOrphanRunsOnce(deps: RunDeps, db: Db): Promise<void> {
  let done = orphanCleanups.get(deps);
  if (!done) {
    done = failRunningRuns(db, deps.config.PROJECT_ID, 'runtime 重啟')
      .then((n) => { if (n > 0) console.warn(`[run] 已把 ${n} 個中斷的 run 標成 failed`); })
      .catch((e) => {
        // 清理失敗不擋這次對話；下次再試
        orphanCleanups.delete(deps);
        console.error('[run] 無法清理中斷的 run', errorText(e));
      });
    orphanCleanups.set(deps, done);
  }
  return done;
}

type PreparedRoot = { rootId: string; streamUI: BuiltAgent['streamUI']; close: () => Promise<void> };

async function prepareRootAgent(
  deps: ActiveDeps,
  runId: string,
  threadId: string,
  clock: RunClock,
  gateway: PlatformGateway | undefined,
): Promise<PreparedRoot> {
  const { db, config, model } = deps;
  const instances = await loadInstances(db, config.PROJECT_ID);
  const consultants = instances.filter((i) => i.role === 'consultant');
  if (consultants.length === 0) throw new Error('專案裡還沒有任何顧問');

  // 每位顧問一個沙盒帳號；建立失敗就不執行（不在沒有隔離的狀態下替顧問跑指令）
  await ensureConsultantSandboxes(config.SANDBOX_USER, config.AGENTS_ROOT, consultants.map((c) => c.id));
  const sharedFiles = await syncSharedFiles(db, config.PROJECT_ID, config.SHARED_ROOT);
  for (const i of consultants) await syncSkills(db, config.AGENTS_ROOT, i);
  const secrets = await loadSecrets(db, config.PROJECT_ID);

  if (consultants.length === 1) {
    const root = consultants[0];
    const built = await buildConsultant({
      db, model, config, instance: root, sharedFiles,
      secrets: groupSecrets(secrets, root.id),
      onStepEnd: usageRecorder({ db, projectId: config.PROJECT_ID, runId, instance: root }),
      wrapUpAt: clock.soloWrapUpAt,
      gateway,
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
      tool_events: toolRecords(message),
    });
  };
  const built = await buildManager({
    db, model, config, manager, consultants, sharedFiles, record, clock,
    runner: createConsultantRunner({
      db, model, config, runId, sharedFiles, secrets,
      wrapUpAt: clock.consultantWrapUpAt, stopAt: clock.consultantStopAt, gateway,
    }),
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

export async function startRun(
  runDeps: RunDeps,
  req: { threadId: string; text: string; platformToken?: string; dbToken: string },
): Promise<Response> {
  const { openDb, modelFor, ...rest } = runDeps;
  const deps: ActiveDeps = { ...rest, db: openDb(req.dbToken), model: modelFor(req.platformToken) };
  const { db, config } = deps;
  await assertThreadInProject(db, req.threadId, config.PROJECT_ID);
  await cleanOrphanRunsOnce(runDeps, db);
  const runId = await createRun(db, req.threadId);

  const keepAlive = await startKeepAlive(config.SPRITE_API_SOCK, `run-${runId}`);
  const runTimeoutMs = deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
  const clock = createRunClock(Date.now(), runTimeoutMs);
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
  let finalId: string;
  try {
    const history = await loadHistory(db, req.threadId);
    await insertMessage(db, {
      thread_id: req.threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: req.text,
      ui_message: { id: generateId(), role: 'user', parts: [{ type: 'text', text: req.text }] },
    });
    // 專案通行證只放在記憶體裡傳給 MCP 連線，不寫進沙盒看得到的地方
    const gateway = config.PLATFORM_URL && req.platformToken ? { baseUrl: config.PLATFORM_URL, token: req.platformToken } : undefined;
    const root = await prepareRootAgent(deps, runId, req.threadId, clock, gateway);
    closeAgent = root.close;
    rootId = root.rootId;
    // final 先插入，執行中定期更新，輪詢的前端隨時看得到進度
    finalId = await insertMessage(db, {
      thread_id: req.threadId, run_id: runId, speaker_instance_id: rootId, kind: 'final', content: '',
    });
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
  const saveFinal = (m: UIMessage) => updateMessage(db, finalId, { content: textOf(m), ui_message: m, tool_events: toolRecords(m) });
  const dropFinal = () => deleteMessage(db, finalId).catch((e) => console.error('[run] 無法刪除空白回覆', errorText(e)));
  const progress = progressSaver({
    save: saveFinal,
    touch: () => touchMessage(db, finalId),
    intervalMs: deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS,
  });

  const settle = async (): Promise<RunResult> => {
    const deadline = new Promise<'deadline'>((resolve) => {
      hardTimer = setTimeout(() => resolve('deadline'), hardDeadlineMs);
    });
    const outcome = await Promise.race([consumeToEnd(forServer, (m) => progress.offer(m)), deadline]);
    // 串流結束當下就判定是否逾時，不受之後寫入資料庫花的時間影響
    const timedOut = abort.signal.aborted;
    await progress.stop();
    if (outcome === 'deadline') {
      stop();
      if (!progress.saved) await dropFinal();
      return { status: 'failed', error: TIMEOUT_ERROR };
    }
    const { final, failure } = outcome;
    let saveError: string | undefined;
    if (hasContent(final)) {
      await saveFinal(final).catch((e) => { saveError = `無法儲存回覆：${errorText(e)}`; });
    } else {
      await dropFinal();
    }
    // 只有工具紀錄、沒有文字仍要存下來（事後除錯用），但不算有回覆
    const error = timedOut
      ? TIMEOUT_ERROR
      : failure ?? saveError ?? (textOf(final) ? undefined : NO_REPLY_ERROR);
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
      // 無論收尾成功與否都要停掉心跳並釋放 run，否則這串對話會一直卡在 running
      await progress.stop();
      await finish(result);
    }
  })().catch((e) => console.error('[run] persist crashed', errorText(e)));

  return createUIMessageStreamResponse({ stream: forClient });
}
