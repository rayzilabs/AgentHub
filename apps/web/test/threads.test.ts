import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import { createProject } from '@/lib/services/projects';
import {
  createThread, deleteMemory, getOwnThread, getThreadMessages, listMemories, listThreads, updateMemory,
} from '@/lib/services/threads';
import type { Db } from '@/lib/supabase/admin';
import { seedUser, testDb } from './helpers';

const db = testDb();

async function setup() {
  const owner = await seedUser(db);
  const project = await createProject(db, owner.id, 'p');
  const thread = await createThread(db, owner.id, project.id);
  return { owner, project, thread };
}

describe('threads service', () => {
  it('建立與列出對話；別人拿不到', async () => {
    const { owner, project, thread } = await setup();
    const other = await seedUser(db);
    expect(thread.title).toBe('新對話');
    expect((await listThreads(db, owner.id, project.id)).map((t) => t.id)).toEqual([thread.id]);
    expect((await getOwnThread(db, owner.id, thread.id)).project.id).toBe(project.id);
    const e = await getOwnThread(db, other.id, thread.id).catch((err) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(404);
  });

  it('查專案時資料庫出錯：原樣丟出，不當成 404', async () => {
    const dbError = new Error('connection reset');
    const query = (result: unknown) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) chain[m] = () => chain;
      chain.maybeSingle = async () => result;
      return chain;
    };
    const fakeDb = {
      from: (table: string) => (table === 'threads'
        ? query({ data: { id: 't', project_id: 'p', title: 'x', created_at: '' }, error: null })
        : query({ data: null, error: dbError })),
    } as unknown as Db;
    await expect(getOwnThread(fakeDb, 'u', 't')).rejects.toBe(dbError);
  });

  it('messages 只回 user 與 final 的 ui_message，依時間排序；running 與 error 反映最新 run', async () => {
    const { owner, thread } = await setup();
    const { data: run } = await db.from('runs').insert({ thread_id: thread.id }).select('id').single();
    const ui = (id: string, role: string, text: string) => ({ id, role, parts: [{ type: 'text', text }] });
    await db.from('messages').insert({ thread_id: thread.id, run_id: run!.id, kind: 'user', content: 'Q', ui_message: ui('u1', 'user', 'Q') });
    await db.from('messages').insert({ thread_id: thread.id, run_id: run!.id, kind: 'delegation', content: 'internal' });

    let r = await getThreadMessages(db, owner.id, thread.id);
    expect(r).toEqual({ messages: [ui('u1', 'user', 'Q')], running: true, error: null });

    await db.from('messages').insert({ thread_id: thread.id, run_id: run!.id, kind: 'final', content: 'A', ui_message: ui('a1', 'assistant', 'A') });
    await db.from('runs').update({ status: 'failed', error: '模型掛了' }).eq('id', run!.id);
    r = await getThreadMessages(db, owner.id, thread.id);
    expect(r.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(r.running).toBe(false);
    expect(r.error).toBe('模型掛了');
  });

  it('running 超過 20 分鐘視為失敗', async () => {
    const { owner, thread } = await setup();
    await db.from('runs').insert({ thread_id: thread.id, started_at: new Date(Date.now() - 21 * 60_000).toISOString() });
    const r = await getThreadMessages(db, owner.id, thread.id);
    expect(r.running).toBe(false);
    expect(r.error).toBe('這次回覆超過 20 分鐘沒有完成');
  });

  it('記憶：列出（帶 agent 名稱）、修改、刪除；別人的專案 404', async () => {
    const { owner, project } = await setup();
    const other = await seedUser(db);
    const { data: agent } = await db.from('agent_instances').insert({ project_id: project.id, role: 'consultant', name: '法務顧問' }).select('id').single();
    const { data: m1 } = await db.from('memories').insert({ project_id: project.id, instance_id: agent!.id, content: '私有記憶' }).select('id').single();
    await db.from('memories').insert({ project_id: project.id, content: '專案記憶' });

    const list = await listMemories(db, owner.id, project.id);
    expect(list.map((m) => [m.content, m.agent_name]).sort()).toEqual([['專案記憶', null], ['私有記憶', '法務顧問']]);

    await updateMemory(db, owner.id, project.id, m1!.id, '改過的記憶');
    expect((await listMemories(db, owner.id, project.id)).map((m) => m.content)).toContain('改過的記憶');
    await deleteMemory(db, owner.id, project.id, m1!.id);
    expect(await listMemories(db, owner.id, project.id)).toHaveLength(1);

    const e = await listMemories(db, other.id, project.id).catch((err) => err);
    expect((e as HttpError).status).toBe(404);
  });
});
