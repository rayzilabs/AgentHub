import { describe, expect, it } from 'vitest';
import { NotFoundError, RunConflictError } from '../src/errors';
import {
  assertThreadInProject, createRun, failRunningRuns, finishRun, insertMessage, loadHistory,
} from '../src/run-store';
import { seedProject, seedThread, seedUser, testDb } from './helpers';

const db = testDb();

async function setup() {
  const userId = await seedUser(db);
  const projectId = await seedProject(db, userId);
  const threadId = await seedThread(db, projectId);
  return { userId, projectId, threadId };
}

describe('run-store', () => {
  it('assertThreadInProject：對話不屬於此專案時丟 NotFoundError', async () => {
    const a = await setup();
    const b = await setup();
    await expect(assertThreadInProject(db, a.threadId, a.projectId)).resolves.toBeUndefined();
    await expect(assertThreadInProject(db, a.threadId, b.projectId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('createRun：同一串對話同時建立兩個 run，恰好一個成功', async () => {
    const { threadId } = await setup();
    const results = await Promise.allSettled([createRun(db, threadId), createRun(db, threadId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RunConflictError);
  });

  it('finishRun 之後同一串對話可以再建立 run', async () => {
    const { threadId } = await setup();
    const first = await createRun(db, threadId);
    await finishRun(db, first, { status: 'failed', error: '測試' });
    const { data } = await db.from('runs').select('status, error, finished_at').eq('id', first).single();
    expect(data).toMatchObject({ status: 'failed', error: '測試' });
    expect(data!.finished_at).not.toBeNull();
    await expect(createRun(db, threadId)).resolves.toBeTypeOf('string');
  });

  it('loadHistory：只取 user 與 final，依時間排序並轉成 ModelMessage', async () => {
    const { threadId } = await setup();
    const runId = await createRun(db, threadId);
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: '問題一' });
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'delegation', content: '內部派工' });
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'final', content: '回答一' });
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: '問題二' });
    expect(await loadHistory(db, threadId)).toEqual([
      { role: 'user', content: '問題一' },
      { role: 'assistant', content: '回答一' },
      { role: 'user', content: '問題二' },
    ]);
  });

  it('loadHistory：超過上限時保留最新的訊息', async () => {
    const { threadId } = await setup();
    const runId = await createRun(db, threadId);
    for (const n of [1, 2, 3]) {
      await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: `第${n}則` });
    }
    expect(await loadHistory(db, threadId, 2)).toEqual([
      { role: 'user', content: '第2則' },
      { role: 'user', content: '第3則' },
    ]);
  });

  it('failRunningRuns：只把本專案 running 的 run 改成 failed', async () => {
    const a = await setup();
    const b = await setup();
    const runA = await createRun(db, a.threadId);
    const runB = await createRun(db, b.threadId);
    expect(await failRunningRuns(db, a.projectId, 'runtime 重啟')).toBe(1);
    const { data } = await db.from('runs').select('id, status, error').in('id', [runA, runB]);
    expect(data!.find((r) => r.id === runA)).toMatchObject({ status: 'failed', error: 'runtime 重啟' });
    expect(data!.find((r) => r.id === runB)).toMatchObject({ status: 'running' });
  });
});
