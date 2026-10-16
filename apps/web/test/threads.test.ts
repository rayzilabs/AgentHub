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
    expect(r).toMatchObject({ messages: [ui('u1', 'user', 'Q')], running: true, error: null });
    expect(r.startedAt).toBeTruthy();
    expect(r.updatedAt).toBeTruthy();

    await db.from('messages').insert({ thread_id: thread.id, run_id: run!.id, kind: 'final', content: 'A', ui_message: ui('a1', 'assistant', 'A') });
    await db.from('runs').update({ status: 'failed', error: '模型掛了' }).eq('id', run!.id);
    r = await getThreadMessages(db, owner.id, thread.id);
    expect(r.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(r.running).toBe(false);
    expect(r.error).toBe('模型掛了');
  });

  it('startedAt 是最新 run 的開始時間；updatedAt 是該 run 訊息中最新的 updated_at（含還沒有內容的 final）', async () => {
    const { owner, thread } = await setup();
    const ui = (id: string, role: string, text: string) => ({ id, role, parts: [{ type: 'text', text }] });
    const { data: old } = await db.from('runs')
      .insert({ thread_id: thread.id, status: 'succeeded', started_at: '2026-10-13T00:00:00Z' }).select('id').single();
    await db.from('messages').insert({
      thread_id: thread.id, run_id: old!.id, kind: 'final', content: 'A', ui_message: ui('a0', 'assistant', 'A'), updated_at: '2026-10-13T00:09:00Z',
    });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const { data: run } = await db.from('runs').insert({ thread_id: thread.id, started_at: startedAt }).select('id').single();
    await db.from('messages').insert([
      { thread_id: thread.id, run_id: run!.id, kind: 'user', content: 'Q', ui_message: ui('u1', 'user', 'Q'), updated_at: '2026-10-13T01:00:00Z' },
      { thread_id: thread.id, run_id: run!.id, kind: 'final', content: '', updated_at: '2026-10-13T01:00:30Z' },
    ]);
    const r = await getThreadMessages(db, owner.id, thread.id);
    expect(r.running).toBe(true);
    expect(Date.parse(r.startedAt!)).toBe(Date.parse(startedAt));
    expect(Date.parse(r.updatedAt!)).toBe(Date.parse('2026-10-13T01:00:30Z'));
    expect(r.messages.map((m) => m.id)).toEqual(['a0', 'u1']);
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
    const { data: m1 } = await db.from('memories')
      .insert({ project_id: project.id, instance_id: agent!.id, name: 'style', description: '報告風格', type: 'feedback', content: '私有記憶' })
      .select('id').single();
    await db.from('memories').insert({ project_id: project.id, name: 'risk', description: '風險偏好', type: 'user', content: '專案記憶' });

    const list = await listMemories(db, owner.id, project.id);
    // 依更新時間新到舊
    expect(list.map((m) => [m.name, m.type, m.description, m.content, m.agent_name])).toEqual([
      ['risk', 'user', '風險偏好', '專案記憶', null],
      ['style', 'feedback', '報告風格', '私有記憶', '法務顧問'],
    ]);

    await updateMemory(db, owner.id, project.id, m1!.id, { description: '新說明' });
    expect((await listMemories(db, owner.id, project.id))[0]).toMatchObject({ name: 'style', description: '新說明', content: '私有記憶' });
    await updateMemory(db, owner.id, project.id, m1!.id, { content: '改過的記憶' });
    expect((await listMemories(db, owner.id, project.id))[0]).toMatchObject({ description: '新說明', content: '改過的記憶' });
    await deleteMemory(db, owner.id, project.id, m1!.id);
    expect(await listMemories(db, owner.id, project.id)).toHaveLength(1);

    const e = await listMemories(db, other.id, project.id).catch((err) => err);
    expect((e as HttpError).status).toBe(404);
  });
});
