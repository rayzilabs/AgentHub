import type { ModelMessage, UIMessageChunk } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { CONSULTANT_WRAP_UP, wrapUpStep } from '../src/agents/build';
import type { Db } from '../src/db';
import { createInbox, withInbox, type Inbox } from '../src/inbox';
import { createRun } from '../src/run-store';
import { seedProject, seedThread, seedUser, testDb } from './helpers';

const db = testDb();

async function setup() {
  const threadId = await seedThread(db, await seedProject(db, await seedUser(db)));
  const runId = await createRun(db, threadId);
  await db.from('queued_messages').insert({ thread_id: threadId, text: '再看一下第 7 條' }).throwOnError();
  return { threadId, runId };
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const streamOf = (...chunks: UIMessageChunk[]) => new ReadableStream<UIMessageChunk>({
  start(c) {
    for (const chunk of chunks) c.enqueue(chunk);
    c.close();
  },
});

describe('createInbox', () => {
  it('take 寫入 interjection 列並回傳 user 訊息', async () => {
    const { threadId, runId } = await setup();
    const inbox = createInbox({ db, threadId, runId });

    expect(await inbox.take()).toEqual([{ role: 'user', content: '使用者在你工作途中補充：\n再看一下第 7 條' }]);

    const { data } = await db.from('messages').select('kind, content, run_id').eq('thread_id', threadId);
    expect(data).toEqual([{ kind: 'interjection', content: '再看一下第 7 條', run_id: runId }]);
    expect(await inbox.take()).toEqual([]);
  });

  it('take 失敗時回 [] 不丟錯', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { from: () => { throw new Error('資料庫斷線'); } } as unknown as Db;
    await expect(createInbox({ db: broken, threadId: 't', runId: 'r' }).take()).resolves.toEqual([]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('寫 interjection 列失敗時仍交給模型，訊息不會遺失', async () => {
    const { threadId, runId } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const noWrites = {
      from: (table: string) => {
        if (table === 'messages') throw new Error('寫入失敗');
        return db.from(table);
      },
    } as unknown as Db;
    const inbox = createInbox({ db: noWrites, threadId, runId });

    expect(await inbox.take()).toHaveLength(1);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('pipe 把訊息插在下一個 start-step 之前', async () => {
    const { threadId, runId } = await setup();
    const inbox = createInbox({ db, threadId, runId });
    const piped = inbox.pipe(streamOf({ type: 'start' }, { type: 'start-step' }, { type: 'finish-step' }));
    await inbox.take();

    const chunks = await collect(piped);
    expect(chunks.map((c) => c.type)).toEqual(['start', 'data-interjection', 'start-step', 'finish-step']);
    expect(chunks[1]).toMatchObject({ data: { text: '再看一下第 7 條' } });
    expect((chunks[1] as { id: string }).id).toBe((chunks[1] as unknown as { data: { id: string } }).data.id);
  });

  it('串流結束前沒有下一步：取走的訊息仍要送出', async () => {
    const { threadId, runId } = await setup();
    const inbox = createInbox({ db, threadId, runId });
    await inbox.take();
    const chunks = await collect(inbox.pipe(streamOf({ type: 'start' })));
    expect(chunks.map((c) => c.type)).toEqual(['start', 'data-interjection']);
  });
});

describe('withInbox', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: '問題' }];
  const inboxOf = (...extra: ModelMessage[]) => ({ take: async () => extra }) as unknown as Inbox;

  it('沒有排隊訊息時不覆寫 messages', async () => {
    const prepare = withInbox(() => ({}), inboxOf());
    expect(await prepare({ stepNumber: 1, messages })).toEqual({});
  });

  it('收尾階段仍讀得到排隊訊息', async () => {
    const extra: ModelMessage = { role: 'user', content: '補充' };
    const prepare = withInbox(wrapUpStep(0, '指示', CONSULTANT_WRAP_UP), inboxOf(extra));
    expect(await prepare({ stepNumber: 1, messages })).toMatchObject({ toolChoice: 'none', messages: [...messages, extra] });
  });

  it('沒有 inbox 的顧問維持原本的 prepareStep', async () => {
    expect(await withInbox(() => ({}))({ stepNumber: 1, messages })).toEqual({});
  });
});
