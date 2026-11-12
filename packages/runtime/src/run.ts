import { createUIMessageStreamResponse, generateId, type LanguageModel, type UIMessage, type UIMessageChunk } from 'ai';
import { activeRuns } from './active-runs';
import { createImageRegistry, type ImageRegistry } from './images';
import { buildConsultant, buildManager, type BuiltAgent, type PlatformGateway } from './agents/build';
import type { DeliveryBudget } from './tools/deliver';
import { createConsultantRunner, type RecordSpeech } from './consultant';
import type { Config } from './config';
import type { Db } from './db';
import { errorText, USER_STOP } from './errors';
import { createInbox } from './inbox';
import { startKeepAlive } from './keepalive';
import { groupSecrets, loadInstances, loadSecrets } from './project-store';
import { progressSaver, PROGRESS_INTERVAL_MS } from './progress';
import { createRunClock, type RunClock } from './run-clock';
import { consultantRequirements, ensureConsultantEnv, type EnvResult } from './requirements';
import { createSandbox, ensureConsultantSandboxes, runInSandbox, sandboxUserFor } from './sandbox';
import {
  assertThreadInProject, createRun, deleteMessage, failRunningRuns, finishRun, hasQueued, insertMessage, loadHistory, takeQueued,
  touchMessage, updateMessage, type RunResult,
} from './run-store';
import { agentDir, skillsDir, syncSharedFiles, syncSkills } from './sync';
import { consumeToEnd, hasContent, interruptedMessage, interruptedProgress, textOf, toolRecords } from './ui-stream';
import { usageRecorder } from './usage';

export const RUN_TIMEOUT_MS = 15 * 60_000;
/** 按停止後等串流自己結束的時間，超過就強制收尾 */
export const STOP_GRACE_MS = 10_000;
const TIMEOUT_ERROR = 'run 超過 15 分鐘';
const NO_REPLY_ERROR = '模型沒有產生回覆';

/** runTimeoutMs、progressIntervalMs、stopGraceMs 只給測試縮短時間用，正式環境一律用預設值 */
export type RunDeps = {
  /** 用 Vercel 附上的 runtime 帳號通行證開這次 run 的資料庫連線 */
  openDb: (dbToken: string) => Db;
  /** 模型經平台代理呼叫，用專案通行證驗證；images 讓請求送出前把共用資料夾的圖片換成簽名網址 */
  modelFor: (platformToken: string, images?: ImageRegistry) => LanguageModel;
  config: Config;
  runTimeoutMs?: number;
  progressIntervalMs?: number;
  stopGraceMs?: number;
  /** 測試用：取代呼叫平台的 fetch */
  fetchImpl?: typeof fetch;
};

type ActiveDeps = Omit<RunDeps, 'openDb' | 'modelFor'> & { db: Db; model: LanguageModel; images: ImageRegistry };

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
  gateway: PlatformGateway,
): Promise<PreparedRoot> {
  const { db, config, model, images } = deps;
  const instances = await loadInstances(db, config.PROJECT_ID);
  const consultants = instances.filter((i) => i.role === 'consultant');
  if (consultants.length === 0) throw new Error('專案裡還沒有任何顧問');

  // 每位顧問一個沙盒帳號；建立失敗就不執行（不在沒有隔離的狀態下替顧問跑指令）
  await ensureConsultantSandboxes(config.SANDBOX_USER, config.AGENTS_ROOT, consultants.map((c) => c.id));
  // 以下三件事互不相關，同時做；錯誤照原本的順序回報（先檔案同步、再 skill 與套件、最後金鑰）
  // /shared 的寫入與刪除以主管的沙盒帳號執行，不用 runtime 帳號（見 sync.ts）
  const pendingShared = syncSharedFiles(db, config.PROJECT_ID, config.SHARED_ROOT, {
    sandbox: createSandbox(config.SANDBOX_USER), statePath: config.SYNC_STATE_PATH,
  });
  // 各顧問先同步自己的 skill，再依 skill 的 requirements.txt 以顧問自己的帳號在工作目錄建虛擬環境（裝過的不重裝）
  const pendingEnvs = Promise.all(consultants.map(async (i): Promise<[string, EnvResult]> => {
    await syncSkills(db, config.AGENTS_ROOT, i);
    const workDir = agentDir(config.AGENTS_ROOT, i.id);
    const sandbox = createSandbox(sandboxUserFor(config, i.id));
    return [i.id, await ensureConsultantEnv({
      workDir,
      requirements: await consultantRequirements(skillsDir(config.AGENTS_ROOT, i.id), i.skills),
      run: (argv, input) => runInSandbox(sandbox, argv, { cwd: workDir, input }),
    })];
  }));
  const pendingSecrets = loadSecrets(db, config.PROJECT_ID);
  for (const p of [pendingShared, pendingEnvs, pendingSecrets]) p.catch(() => undefined);
  const sharedFiles = await pendingShared;
  images.useSharedFiles(sharedFiles);
  const envs = new Map<string, EnvResult>(await pendingEnvs);
  const secrets = await pendingSecrets;
  // 一個 run 一份：所有顧問交付的檔案合計不超過上限
  const deliveries: DeliveryBudget = { used: 0 };
  const inbox = createInbox({ db, threadId, runId });

  if (consultants.length === 1) {
    const root = consultants[0];
    const built = await buildConsultant({
      db, model, config, instance: root, sharedFiles, images, runId, deliveries,
      secrets: groupSecrets(secrets, root.id),
      onStepEnd: usageRecorder({ db, projectId: config.PROJECT_ID, runId, instance: root }),
      wrapUpAt: clock.soloWrapUpAt,
      gateway,
      env: envs.get(root.id),
      inbox,
    });
    return { rootId: root.id, streamUI: built.streamUI, close: built.close };
  }

  const manager = instances.find((i) => i.role === 'manager');
  if (!manager) throw new Error('找不到主管');

  const record: RecordSpeech = async (instance, message, round, summary) => {
    await insertMessage(db, {
      thread_id: threadId,
      run_id: runId,
      speaker_instance_id: instance.id,
      kind: round === null ? 'delegation' : 'discussion',
      round,
      content: summary ?? textOf(message),
      tool_events: toolRecords(message),
    });
  };
  const built = await buildManager({
    db, model, config, manager, consultants, sharedFiles, record, clock, images, inbox,
    runner: createConsultantRunner({
      db, model, config, runId, sharedFiles, secrets, images, envs, deliveries,
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

/**
 * 這輪結束時還有排隊訊息，請平台開下一輪：這裡的通行證撐不完下一輪，要由平台重新簽發。
 * 失敗只記 log，訊息留在排隊區，下次打開對話時回到輸入框。
 */
async function continueQueued(deps: ActiveDeps, threadId: string, platformToken: string): Promise<void> {
  try {
    if (!(await hasQueued(deps.db, threadId))) return;
    const res = await (deps.fetchImpl ?? fetch)(`${deps.config.PLATFORM_URL}/api/runtime/threads/${threadId}/continue`, {
      method: 'POST',
      headers: { authorization: `Bearer ${platformToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error('[run] 無法接續排隊訊息', errorText(e));
  }
}

/** 沒有 text 代表平台要接續排隊訊息，這輪的使用者訊息由 run 建立之後才取走（撞到 409 時訊息要留著） */
export async function startRun(
  runDeps: RunDeps,
  req: { threadId: string; text?: string; platformToken: string; dbToken: string },
): Promise<Response> {
  const { openDb, modelFor, ...rest } = runDeps;
  const { config } = rest;
  const db = openDb(req.dbToken);
  // 一個 run 一份：read_file 確認過的共用資料夾圖片，送模型請求前換成簽名網址
  const images = createImageRegistry(db, config.PROJECT_ID, config.SHARED_ROOT);
  const deps: ActiveDeps = { ...rest, db, images, model: modelFor(req.platformToken, images) };
  await assertThreadInProject(db, req.threadId, config.PROJECT_ID);
  await cleanOrphanRunsOnce(runDeps, db);
  const runId = await createRun(db, req.threadId);
  const abort = new AbortController();
  let stopped = false;
  let finished = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let endGrace!: () => void;
  const graceOver = new Promise<'deadline'>((resolve) => {
    endGrace = () => resolve('deadline');
  });
  let flushProgress = () => {};
  const requestStop = () => {
    if (stopped) return;
    stopped = true;
    // 已經在收尾：這輪不用中止了，但結束後不能接續排隊訊息
    if (finished) return;
    abort.abort(USER_STOP);
    flushProgress();
    graceTimer = setTimeout(endGrace, deps.stopGraceMs ?? STOP_GRACE_MS);
  };
  activeRuns.set(runId, requestStop);

  const keepAlive = await startKeepAlive(config.SPRITE_API_SOCK, `run-${runId}`);
  const runTimeoutMs = deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
  const clock = createRunClock(Date.now(), runTimeoutMs);
  // 時間到先通知 agent 中止；工具或串流卡住、中止沒有效果時，再過一段時間強制收尾
  const hardDeadlineMs = runTimeoutMs + Math.min(30_000, runTimeoutMs);
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
    abort.abort();
  }, runTimeoutMs);
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let closeAgent: (() => Promise<void>) | undefined;
  const finish = async (result: RunResult, beforeRelease?: () => Promise<void>) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(hardTimer);
    clearTimeout(graceTimer);
    await closeAgent?.().catch(() => undefined);
    await finishRun(db, runId, result).catch((e) => console.error('[run] 無法更新 run 狀態', errorText(e)));
    // 狀態寫完才移除：平台在「已移除、狀態還沒寫」的空檔問到時，會誤判成中斷
    activeRuns.delete(runId);
    // 取消登記後 Sprite 會休眠，還沒送出的請求會凍結到有人叫醒它為止，所以收尾要做的事都放在這之前
    await beforeRelease?.();
    await keepAlive.stop();
  };

  let uiStream: ReadableStream<UIMessageChunk>;
  let rootId: string;
  let finalId: string;
  try {
    const history = await loadHistory(db, req.threadId);
    const text = req.text ?? (await takeQueued(db, req.threadId)).map((m) => m.text).join('\n\n');
    if (!text) {
      await finish({ status: 'succeeded' });
      return new Response(null, { status: 204 });
    }
    await insertMessage(db, {
      thread_id: req.threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: text,
      ui_message: { id: generateId(), role: 'user', parts: [{ type: 'text', text }] },
    });
    // 專案通行證只放在記憶體裡傳給 MCP 連線，不寫進沙盒看得到的地方
    const root = await prepareRootAgent(deps, runId, req.threadId, clock, { baseUrl: config.PLATFORM_URL, token: req.platformToken });
    closeAgent = root.close;
    rootId = root.rootId;
    // 準備階段（同步檔案、裝套件）不能中止，等它做完才處理停止
    if (stopped) {
      await insertMessage(db, {
        thread_id: req.threadId, run_id: runId, speaker_instance_id: rootId, kind: 'final', content: '',
        ui_message: interruptedMessage(undefined),
      });
      await finish({ status: 'cancelled' });
      return createUIMessageStreamResponse({ stream: new ReadableStream({ start: (c) => c.close() }) });
    }
    // final 先插入，執行中定期更新，輪詢的前端隨時看得到進度
    finalId = await insertMessage(db, {
      thread_id: req.threadId, run_id: runId, speaker_instance_id: rootId, kind: 'final', content: '',
    });
    uiStream = await root.streamUI({
      messages: [...history, { role: 'user', content: text }],
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
  flushProgress = progress.flush;

  const settle = async (): Promise<RunResult> => {
    const deadline = new Promise<'deadline'>((resolve) => {
      hardTimer = setTimeout(() => resolve('deadline'), hardDeadlineMs);
    });
    let latest: UIMessage | undefined;
    const consumed = consumeToEnd(forServer, (m) => {
      latest = m;
      progress.offer(m);
    });
    const outcome = await Promise.race([consumed, deadline, graceOver]);
    // 串流結束當下就判定結果，不受之後寫入資料庫花的時間影響
    const timedOut = timerFired;
    const interrupted = stopped;
    await progress.stop();
    if (interrupted) {
      stop();
      const partial = outcome === 'deadline' ? latest : outcome.final ?? latest;
      const m = interruptedMessage(partial);
      await updateMessage(db, finalId, { content: interruptedProgress(partial), ui_message: m, tool_events: toolRecords(m) })
        .catch((e) => console.error('[run] 無法儲存中斷的回覆', errorText(e)));
      return { status: 'cancelled' };
    }
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
      await finish(result, async () => {
        if (result.status === 'succeeded' && !stopped) await continueQueued(deps, req.threadId, req.platformToken);
      });
    }
  })().catch((e) => console.error('[run] persist crashed', errorText(e)));

  return createUIMessageStreamResponse({ stream: forClient });
}
