import type { LanguageModel, UIMessage } from 'ai';
import { buildConsultant } from './agents/build';
import type { Config } from './config';
import type { Db } from './db';
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
};

export function createConsultantRunner(deps: ConsultantRunnerDeps): ConsultantRunner {
  return async function* runConsultant(instance, task, abortSignal) {
    const built = await buildConsultant({
      db: deps.db,
      model: deps.model,
      config: deps.config,
      instance,
      sharedFiles: deps.sharedFiles,
      secrets: groupSecrets(deps.secrets, instance.id),
      onStepEnd: usageRecorder({ db: deps.db, projectId: deps.config.PROJECT_ID, runId: deps.runId, instance }),
    });
    try {
      const snapshots = readSnapshots(await built.streamUI({ messages: [{ role: 'user', content: task }], abortSignal }));
      let r = await snapshots.next();
      while (!r.done) {
        yield r.value;
        r = await snapshots.next();
      }
      if (r.value.failure) throw new Error(r.value.failure);
      if (!hasContent(r.value.final)) throw new Error(`${instance.name} 沒有產生任何回覆`);
    } finally {
      await built.close();
    }
  };
}
