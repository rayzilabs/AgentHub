import { describe, expect, it } from 'vitest';
import { createConsultantRunner } from '../src/consultant';
import { createRun } from '../src/run-store';
import { loadInstances } from '../src/project-store';
import { textOf } from '../src/ui-stream';
import { seedConsultant, seedProject, seedThread, seedUser, testDb, tmpRoots, waitFor } from './helpers';
import { failingModel, mockModel, promptText, textTurn } from './mock-model';
import type { LanguageModel } from 'ai';

const db = testDb();

async function setup(model: LanguageModel) {
  const projectId = await seedProject(db, await seedUser(db));
  const threadId = await seedThread(db, projectId);
  const runId = await createRun(db, threadId);
  const consultantId = await seedConsultant(db, projectId, { system_prompt: '你是稅務顧問。' });
  const roots = await tmpRoots();
  const [instance] = await loadInstances(db, projectId);
  const run = createConsultantRunner({
    db, model, runId, sharedFiles: [], secrets: [],
    config: { PROJECT_ID: projectId, AGENTS_ROOT: roots.agentsRoot, SHARED_ROOT: roots.sharedRoot },
  });
  return { run, instance, runId, consultantId };
}

describe('createConsultantRunner', () => {
  it('產生快照，最後一個快照是完整回覆；任務當作使用者訊息、記錄用量', async () => {
    const model = mockModel(textTurn('稅務建議如下'));
    const { run, instance, runId, consultantId } = await setup(model);
    const snapshots = [];
    for await (const m of run(instance, '幫我看節稅方案')) snapshots.push(m);
    expect(textOf(snapshots.at(-1))).toBe('稅務建議如下');
    expect(promptText(model)).toContain('幫我看節稅方案');
    expect(promptText(model)).toContain('你是稅務顧問。');
    const rows = await waitFor(async () => {
      const { data } = await db.from('usage_events').select('instance_id').eq('run_id', runId);
      return data?.length ? data : undefined;
    });
    expect(rows[0].instance_id).toBe(consultantId);
  });

  it('模型出錯時丟出錯誤', async () => {
    const { run, instance } = await setup(failingModel('顧問掛了'));
    const consume = async () => {
      for await (const _ of run(instance, '任務')) { /* drain */ }
    };
    await expect(consume()).rejects.toThrow('顧問掛了');
  });
});
