import type { LanguageModel, UIMessage } from 'ai';
import { buildConsultant } from './agents/build';
import type { Config } from './config';
import type { Db } from './db';
import { ConsultantStoppedError } from './errors';
import { groupSecrets } from './project-store';
import type { AgentInstance, SecretRow } from './types';
import { hasContent, readSnapshots } from './ui-stream';
import { usageRecorder } from './usage';

export type ConsultantRunner = (instance: AgentInstance, task: string, abortSignal?: AbortSignal) => AsyncGenerator<UIMessage>;

export type RecordSpeech = (instance: AgentInstance, message: UIMessage, round: number | null) => Promise<void>;

export type ConsultantRunnerDeps = {
  db: Db;
  model: LanguageModel;
  config: Pick<Config, 'PROJECT_ID' | 'AGENTS_ROOT' | 'SHARED_ROOT'>;
  runId: string;
  sharedFiles: string[];
  secrets: SecretRow[];
  /** 過了這個時間顧問收尾（不准再用工具） */
  wrapUpAt?: number;
  /** 過了這個時間強制停止顧問 */
  stopAt?: number;
};

export function createConsultantRunner(deps: ConsultantRunnerDeps): ConsultantRunner {
  return async function* runConsultant(instance, task, abortSignal) {
    const stopSignal = deps.stopAt === undefined ? undefined : AbortSignal.timeout(Math.max(0, deps.stopAt - Date.now()));
    const signal = stopSignal && abortSignal ? AbortSignal.any([abortSignal, stopSignal]) : stopSignal ?? abortSignal;
    const built = await buildConsultant({
      db: deps.db,
      model: deps.model,
      config: deps.config,
      instance,
      sharedFiles: deps.sharedFiles,
      secrets: groupSecrets(deps.secrets, instance.id),
      onStepEnd: usageRecorder({ db: deps.db, projectId: deps.config.PROJECT_ID, runId: deps.runId, instance }),
      wrapUpAt: deps.wrapUpAt,
    });
    try {
      const snapshots = readSnapshots(await built.streamUI({ messages: [{ role: 'user', content: task }], abortSignal: signal }));
      let r = await snapshots.next();
      while (!r.done) {
        yield r.value;
        r = await snapshots.next();
      }
      if (r.value.failure) {
        // 只有串流以失敗收場、且是停止計時器造成的，才算逾時；正常完成後計時器才觸發不算
        if (stopSignal?.aborted && !abortSignal?.aborted) throw new ConsultantStoppedError(`${instance.name} 超過時間上限`);
        throw new Error(r.value.failure);
      }
      if (!hasContent(r.value.final)) throw new Error(`${instance.name} 沒有產生任何回覆`);
    } finally {
      await built.close();
    }
  };
}
