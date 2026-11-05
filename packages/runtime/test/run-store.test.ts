import { describe, expect, it } from 'vitest';
import { NotFoundError, RunConflictError } from '../src/errors';
import {
  assertThreadInProject, createRun, deleteMessage, failRunningRuns, finishRun, hasQueued, insertMessage, INTERRUPTED_HEADER,
  loadHistory, takeQueued, touchMessage, updateMessage,
} from '../src/run-store';
import type { MessageKind } from '../src/types';
import { seedConsultant, seedProject, seedThread, seedUser, testDb } from './helpers';

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

  it('loadHistory：截斷後開頭若是 assistant 訊息就丟掉，從 user 開始', async () => {
    const { threadId } = await setup();
    const runId = await createRun(db, threadId);
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: '問題一' });
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'final', content: '回答一' });
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: '問題二' });
    expect(await loadHistory(db, threadId, 2)).toEqual([{ role: 'user', content: '問題二' }]);
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

describe('進度存檔', () => {
  async function newRun() {
    const threadId = await seedThread(db, await seedProject(db, await seedUser(db)));
    return { threadId, runId: await createRun(db, threadId) };
  }

  it('updateMessage 更新內容；touchMessage 只推進 updated_at；deleteMessage 刪除', async () => {
    const { threadId, runId } = await newRun();
    const id = await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'final', content: '' });
    const read = async () => (await db.from('messages').select('content, ui_message, tool_events, updated_at').eq('id', id).single()).data!;

    await updateMessage(db, id, { content: '進行中', ui_message: { id: 'm', role: 'assistant', parts: [] }, tool_events: [{ tool: 'bash' }] });
    const updated = await read();
    expect(updated).toMatchObject({ content: '進行中', ui_message: { id: 'm' }, tool_events: [{ tool: 'bash' }] });

    await new Promise((r) => setTimeout(r, 20));
    await touchMessage(db, id);
    const touched = await read();
    expect(touched.content).toBe('進行中');
    expect(Date.parse(touched.updated_at)).toBeGreaterThan(Date.parse(updated.updated_at));

    await deleteMessage(db, id);
    expect((await db.from('messages').select('id').eq('id', id)).data).toEqual([]);
  });

  it('loadHistory 略過沒有內容的 final（runtime 崩潰時留下的佔位列）', async () => {
    const { threadId, runId } = await newRun();
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: '問題' });
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'final', content: '' });
    expect(await loadHistory(db, threadId)).toEqual([{ role: 'user', content: '問題' }]);
  });
});

describe('排隊訊息', () => {
  async function queue(threadId: string, ...rows: { text: string; created_at?: string }[]) {
    await db.from('queued_messages').insert(rows.map((r) => ({ thread_id: threadId, ...r }))).throwOnError();
  }

  it('takeQueued 依時間回傳，第二次取不到', async () => {
    const { threadId } = await setup();
    await queue(threadId, { text: 'b', created_at: '2026-11-05T10:00:01Z' }, { text: 'a', created_at: '2026-11-05T10:00:00Z' });
    expect((await takeQueued(db, threadId)).map((m) => m.text)).toEqual(['a', 'b']);
    expect(await takeQueued(db, threadId)).toEqual([]);
  });

  it('takeQueued 同時取走時每則只給一方', async () => {
    const { threadId } = await setup();
    await queue(threadId, { text: 'a' }, { text: 'b' });
    const [one, two] = await Promise.all([takeQueued(db, threadId), takeQueued(db, threadId)]);
    expect([...one, ...two].map((m) => m.text).sort()).toEqual(['a', 'b']);
  });

  it('hasQueued 反映這串對話有沒有排隊訊息', async () => {
    const { threadId } = await setup();
    expect(await hasQueued(db, threadId)).toBe(false);
    await queue(threadId, { text: 'a' });
    expect(await hasQueued(db, threadId)).toBe(true);
  });
});

describe('loadHistory 組裝插話與中斷', () => {
  const message = (threadId: string, runId: string, kind: MessageKind, content: string, speaker: string | null = null) =>
    insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: speaker, kind, content });

  it('interjection 排在同 run 的 final 之前', async () => {
    const { threadId } = await setup();
    const runId = await createRun(db, threadId);
    await message(threadId, runId, 'user', '問題');
    await message(threadId, runId, 'final', '回答');
    await message(threadId, runId, 'interjection', '補充一');
    await message(threadId, runId, 'interjection', '補充二');
    expect(await loadHistory(db, threadId)).toEqual([
      { role: 'user', content: '問題' },
      { role: 'user', content: '補充一' },
      { role: 'user', content: '補充二' },
      { role: 'assistant', content: '回答' },
    ]);
  });

  it('一般完成的 run 不帶 delegation', async () => {
    const { threadId } = await setup();
    const runId = await createRun(db, threadId);
    await message(threadId, runId, 'user', '問題');
    await message(threadId, runId, 'final', '回答');
    await message(threadId, runId, 'delegation', '顧問報告');
    await finishRun(db, runId, { status: 'succeeded' });
    expect(await loadHistory(db, threadId)).toEqual([
      { role: 'user', content: '問題' },
      { role: 'assistant', content: '回答' },
    ]);
  });

  it('cancelled 的 run 帶入報告並標明顧問', async () => {
    const { threadId, projectId } = await setup();
    const speaker = await seedConsultant(db, projectId, { name: '授信顧問' });
    const runId = await createRun(db, threadId);
    await message(threadId, runId, 'user', '問題');
    await message(threadId, runId, 'final', '主管寫到一半');
    await message(threadId, runId, 'delegation', '顧問報告', speaker);
    await finishRun(db, runId, { status: 'cancelled' });
    expect((await db.from('runs').select('error').eq('id', runId).single()).data!.error).toBeNull();
    expect(await loadHistory(db, threadId)).toEqual([
      { role: 'user', content: '問題' },
      { role: 'assistant', content: `${INTERRUPTED_HEADER}\n\n主管寫到一半\n\n【授信顧問】\n顧問報告` },
    ]);
  });

  it('cancelled 的 run 沒有 final 文字也帶入報告', async () => {
    const { threadId, projectId } = await setup();
    const speaker = await seedConsultant(db, projectId, { name: '授信顧問' });
    const runId = await createRun(db, threadId);
    await message(threadId, runId, 'user', '問題');
    await message(threadId, runId, 'final', '');
    await message(threadId, runId, 'delegation', '顧問報告', speaker);
    await finishRun(db, runId, { status: 'cancelled' });
    expect(await loadHistory(db, threadId)).toEqual([
      { role: 'user', content: '問題' },
      { role: 'assistant', content: `${INTERRUPTED_HEADER}\n\n【授信顧問】\n顧問報告` },
    ]);
  });

  it('cancelled 的 run 沒有 final 列時在該輪最後補一則', async () => {
    const { threadId, projectId } = await setup();
    const speaker = await seedConsultant(db, projectId, { name: '授信顧問' });
    const runId = await createRun(db, threadId);
    await message(threadId, runId, 'user', '問題');
    await message(threadId, runId, 'delegation', '顧問報告', speaker);
    await finishRun(db, runId, { status: 'cancelled' });
    const nextRun = await createRun(db, threadId);
    await message(threadId, nextRun, 'user', '繼續');
    expect(await loadHistory(db, threadId)).toEqual([
      { role: 'user', content: '問題' },
      { role: 'assistant', content: `${INTERRUPTED_HEADER}\n\n【授信顧問】\n顧問報告` },
      { role: 'user', content: '繼續' },
    ]);
  });

  it('cancelled 的 run 什麼內容都沒有時不放進歷史', async () => {
    const { threadId } = await setup();
    const runId = await createRun(db, threadId);
    await message(threadId, runId, 'user', '問題');
    await message(threadId, runId, 'final', '');
    await finishRun(db, runId, { status: 'cancelled' });
    expect(await loadHistory(db, threadId)).toEqual([{ role: 'user', content: '問題' }]);
  });

  it('報告列不佔歷史上限', async () => {
    const { threadId, projectId } = await setup();
    const speaker = await seedConsultant(db, projectId, { name: '授信顧問' });
    const runId = await createRun(db, threadId);
    await message(threadId, runId, 'user', '問題');
    await message(threadId, runId, 'final', '進度');
    await message(threadId, runId, 'delegation', '報告一', speaker);
    await message(threadId, runId, 'delegation', '報告二', speaker);
    await message(threadId, runId, 'delegation', '報告三', speaker);
    await finishRun(db, runId, { status: 'cancelled' });
    const history = await loadHistory(db, threadId, 2);
    expect(history).toHaveLength(2);
    expect(history[1].content).toContain('報告三');
  });
});
