import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as continuePost } from '@/app/api/runtime/threads/[id]/continue/route';
import { DELETE as queuedDelete, PATCH as queuedPatch } from '@/app/api/threads/[id]/queue/[queuedId]/route';
import { POST as queuePost } from '@/app/api/threads/[id]/queue/route';
import { POST as stopPost } from '@/app/api/threads/[id]/stop/route';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { signProjectToken } from '@/lib/platform-tokens';
import { askStop, INTERRUPTED_ERROR } from '@/lib/run-liveness';
import { addQueued, deleteQueued, editQueued, startQueuedRun, stopThreadRun } from '@/lib/services/run-control';
import { createProject, type ProjectRow } from '@/lib/services/projects';
import { createThread } from '@/lib/services/threads';
import type { forwardChat } from '@/lib/sprites';
import { seedUser, testDb } from './helpers';

const db = testDb();
const SECRET = 'test-runtime-secret-at-least-32-characters';

async function setup() {
  const owner = await seedUser(db);
  const created = await createProject(db, owner.id, 'p');
  const { data: project } = await db.from('projects')
    .update({ sprite_status: 'ready', sprite_url: 'http://127.0.0.1:9' })
    .eq('id', created.id).select('*').single().throwOnError();
  const thread = await createThread(db, owner.id, created.id);
  return { owner, project: project as ProjectRow, thread };
}

async function startRun(threadId: string): Promise<string> {
  const { data } = await db.from('runs').insert({ thread_id: threadId }).select('id').single().throwOnError();
  return data!.id;
}

const queuedTexts = async (threadId: string) =>
  (await db.from('queued_messages').select('text').eq('thread_id', threadId).order('created_at')).data!.map((r) => r.text);

const fakeForward = (status = 204) =>
  vi.fn<typeof forwardChat>(async () => new Response(status === 204 ? null : 'x', { status }));

async function bearer(user: { email: string; password: string }): Promise<Record<string, string>> {
  const auth = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const { data } = await auth.auth.signInWithPassword(user);
  return { authorization: `Bearer ${data.session!.access_token}`, 'content-type': 'application/json' };
}

const request = (headers: Record<string, string>, body?: unknown) =>
  new Request('https://p.test/api', { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => { vi.stubEnv('RUNTIME_TOKEN_SECRET', SECRET); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('askStop', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;

  it('依回答分成 stopped / gone / unknown，帶資料庫通行證與 Fly 驗證', async () => {
    const stopped = answer(200, { stopped: true });
    expect(await askStop('https://s', 'r1', 'db', stopped)).toBe('stopped');
    const [url, init] = (stopped as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://s/runs/r1/stop');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { authorization: `Bearer ${env.spritesToken}`, 'x-agenthub-db-token': 'db' },
    });

    expect(await askStop('https://s', 'r1', 'db', answer(200, { stopped: false }))).toBe('gone');
    // 舊版 runtime 沒有這個路由，回 404，不能當成 run 已經不在
    expect(await askStop('https://s', 'r1', 'db', answer(404, {}))).toBe('unknown');
    expect(await askStop('https://s', 'r1', 'db', answer(200, { ok: true }))).toBe('unknown');
    const unreachable = vi.fn(async () => { throw new Error('連不上'); }) as unknown as typeof fetch;
    expect(await askStop('https://s', 'r1', 'db', unreachable)).toBe('unknown');
  });
});

describe('stopThreadRun', () => {
  it('沒有 running run 時不呼叫 runtime', async () => {
    const { owner, thread } = await setup();
    const ask = vi.fn<typeof askStop>();
    await stopThreadRun(db, owner.id, thread.id, ask);
    expect(ask).not.toHaveBeenCalled();
  });

  it('runtime 回 stopped 時由 runtime 收尾，平台不改狀態', async () => {
    const { owner, thread } = await setup();
    const runId = await startRun(thread.id);
    await stopThreadRun(db, owner.id, thread.id, async () => 'stopped');
    expect((await db.from('runs').select('status').eq('id', runId).single()).data).toEqual({ status: 'running' });
  });

  it('runtime 回 gone 時標成中斷', async () => {
    const { owner, thread } = await setup();
    const runId = await startRun(thread.id);
    await stopThreadRun(db, owner.id, thread.id, async () => 'gone');
    expect((await db.from('runs').select('status, error').eq('id', runId).single()).data)
      .toEqual({ status: 'failed', error: INTERRUPTED_ERROR });
  });

  it('連不上時回 502，run 維持 running', async () => {
    const { owner, thread } = await setup();
    const runId = await startRun(thread.id);
    const e = await stopThreadRun(db, owner.id, thread.id, async () => 'unknown').catch((err) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 502, message: '暫時無法停止，請再試一次' });
    expect((await db.from('runs').select('status').eq('id', runId).single()).data).toEqual({ status: 'running' });
  });

  it('別人的對話回 404', async () => {
    const { thread } = await setup();
    const other = await seedUser(db);
    await expect(stopThreadRun(db, other.id, thread.id, vi.fn())).rejects.toMatchObject({ status: 404 });
  });
});

describe('addQueued', () => {
  it('沒有 running run 時觸發 forward，不帶 text', async () => {
    const { owner, project, thread } = await setup();
    const forward = fakeForward();
    const view = await addQueued(db, owner.id, thread.id, '補充', forward);

    expect(view).toEqual({ id: expect.any(String), text: '補充' });
    expect(forward).toHaveBeenCalledOnce();
    const [url, body, opts] = forward.mock.calls[0];
    expect(url).toBe(project.sprite_url);
    expect(body).toEqual({ thread_id: thread.id });
    expect(opts).toMatchObject({ projectToken: expect.any(String), dbToken: expect.any(String) });
  });

  it('有 running run 時不觸發 forward', async () => {
    const { owner, thread } = await setup();
    await startRun(thread.id);
    const forward = fakeForward();
    await addQueued(db, owner.id, thread.id, '補充', forward);
    expect(forward).not.toHaveBeenCalled();
    expect(await queuedTexts(thread.id)).toEqual(['補充']);
  });

  it('接續失敗不影響排隊結果，訊息留著', async () => {
    const { owner, thread } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await addQueued(db, owner.id, thread.id, '補充', vi.fn<typeof forwardChat>(async () => { throw new HttpError(502, '連不上'); }));
    expect(view.text).toBe('補充');
    expect(await queuedTexts(thread.id)).toEqual(['補充']);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('別人的對話回 404，不寫入', async () => {
    const { thread } = await setup();
    const other = await seedUser(db);
    await expect(addQueued(db, other.id, thread.id, '補充', fakeForward())).rejects.toMatchObject({ status: 404 });
    expect(await queuedTexts(thread.id)).toEqual([]);
  });
});

describe('editQueued、deleteQueued', () => {
  it('編輯與刪除排隊中的訊息', async () => {
    const { owner, thread } = await setup();
    await startRun(thread.id);
    const { id } = await addQueued(db, owner.id, thread.id, '原文', fakeForward());
    await editQueued(db, owner.id, thread.id, id, '改過');
    expect(await queuedTexts(thread.id)).toEqual(['改過']);
    await deleteQueued(db, owner.id, thread.id, id);
    expect(await queuedTexts(thread.id)).toEqual([]);
  });

  it('已被取走回 409', async () => {
    const { owner, thread } = await setup();
    const taken = randomUUID();
    await expect(editQueued(db, owner.id, thread.id, taken, 'x')).rejects.toMatchObject({ status: 409, message: '這則訊息已被讀取' });
    await expect(deleteQueued(db, owner.id, thread.id, taken)).rejects.toMatchObject({ status: 409 });
  });

  it('不能動到別串對話的訊息', async () => {
    const a = await setup();
    const b = await setup();
    await startRun(a.thread.id);
    const { id } = await addQueued(db, a.owner.id, a.thread.id, '原文', fakeForward());
    await expect(editQueued(db, b.owner.id, b.thread.id, id, 'x')).rejects.toMatchObject({ status: 409 });
    expect(await queuedTexts(a.thread.id)).toEqual(['原文']);
  });
});

describe('startQueuedRun', () => {
  const queue = (threadId: string, text: string) => db.from('queued_messages').insert({ thread_id: threadId, text }).throwOnError();

  it('沒有排隊時不呼叫 forward', async () => {
    const { project, thread } = await setup();
    const forward = fakeForward();
    await startQueuedRun(db, project, thread.id, forward);
    expect(forward).not.toHaveBeenCalled();
  });

  it('forward 回 409 時不丟錯，排隊列保留', async () => {
    const { project, thread } = await setup();
    await queue(thread.id, '補充');
    await expect(startQueuedRun(db, project, thread.id, fakeForward(409))).resolves.toBeUndefined();
    expect(await queuedTexts(thread.id)).toEqual(['補充']);
  });

  it('forward 回 200 時取消回應內容，不等整輪跑完', async () => {
    const { project, thread } = await setup();
    await queue(thread.id, '補充');
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    await startQueuedRun(db, project, thread.id, vi.fn<typeof forwardChat>(async () => new Response(stream)));
    expect(cancel).toHaveBeenCalled();
  });

  it('forward 回其他錯誤時往外丟', async () => {
    const { project, thread } = await setup();
    await queue(thread.id, '補充');
    await expect(startQueuedRun(db, project, thread.id, fakeForward(500))).rejects.toBeInstanceOf(HttpError);
  });
});

describe('路由', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it('queue：空白內容回 400，不寫入', async () => {
    const { owner, thread } = await setup();
    const res = await queuePost(request(await bearer(owner), { text: '   ' }), ctx(thread.id));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '請輸入訊息' });
    expect(await queuedTexts(thread.id)).toEqual([]);
  });

  it('queue：別人的對話回 404', async () => {
    const { thread } = await setup();
    const other = await seedUser(db);
    const res = await queuePost(request(await bearer(other), { text: '補充' }), ctx(thread.id));
    expect(res.status).toBe(404);
  });

  it('queue：寫入後回傳訊息；PATCH 與 DELETE 走得通', async () => {
    const { owner, thread } = await setup();
    await startRun(thread.id);
    const headers = await bearer(owner);
    const added = await (await queuePost(request(headers, { text: ' 補充 ' }), ctx(thread.id))).json();
    expect(added).toEqual({ id: expect.any(String), text: '補充' });

    const item = { params: Promise.resolve({ id: thread.id, queuedId: added.id }) };
    expect((await queuedPatch(request(headers, { text: '改過' }), item)).status).toBe(200);
    expect(await queuedTexts(thread.id)).toEqual(['改過']);
    expect((await queuedDelete(request(headers), item)).status).toBe(200);
    expect((await queuedDelete(request(headers), item)).status).toBe(409);
  });

  it('stop：沒有 running run 時回成功', async () => {
    const { owner, thread } = await setup();
    const res = await stopPost(request(await bearer(owner)), ctx(thread.id));
    expect(res.status).toBe(200);
  });

  it('continue：沒有通行證回 401', async () => {
    const { thread } = await setup();
    const res = await continuePost(request({}), ctx(thread.id));
    expect(res.status).toBe(401);
  });

  it('continue：通行證的專案與對話不符回 404', async () => {
    const a = await setup();
    const b = await setup();
    const token = signProjectToken(b.project.id, SECRET);
    const res = await continuePost(request({ authorization: `Bearer ${token}` }), ctx(a.thread.id));
    expect(res.status).toBe(404);
  });

  it('continue：專案相符但沒有排隊時回成功', async () => {
    const { project, thread } = await setup();
    const token = signProjectToken(project.id, SECRET);
    const res = await continuePost(request({ authorization: `Bearer ${token}` }), ctx(thread.id));
    expect(res.status).toBe(200);
  });
});
