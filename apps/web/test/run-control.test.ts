import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as continuePost } from '@/app/api/runtime/threads/[id]/continue/route';
import { DELETE as queuedDelete, PATCH as queuedPatch } from '@/app/api/threads/[id]/queue/[queuedId]/route';
import { POST as queuePost } from '@/app/api/threads/[id]/queue/route';
import { POST as stopPost } from '@/app/api/threads/[id]/stop/route';
import { env } from '@/lib/env';
import type { Machine } from '@/lib/hosts/types';
import { HttpError } from '@/lib/http';
import { signProjectToken } from '@/lib/platform-tokens';
import { askStop, INTERRUPTED_ERROR } from '@/lib/run-liveness';
import { addQueued, deleteQueued, editQueued, forwardToRuntime, startQueuedRun, stopThreadRun } from '@/lib/services/run-control';
import { createProject, type ProjectRow } from '@/lib/services/projects';
import { createThread } from '@/lib/services/threads';
import { type forwardChat, RUNTIME_GONE } from '@/lib/project-runtime';
import { fakeRuntimeHost, seedUser, stubHealth, testDb } from './helpers';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => unknown) => { void fn(); },
}));

const db = testDb();
const SECRET = 'test-runtime-secret-at-least-32-characters';

async function setup() {
  const owner = await seedUser(db);
  const created = await createProject(db, owner.id, 'p');
  const { data: project } = await db.from('projects')
    .update({ host: 'sprite', sprite_status: 'ready', sprite_name: `agenthub-${created.id}`, sprite_url: 'http://127.0.0.1:9' })
    .eq('id', created.id).select('*').single().throwOnError();
  const thread = await createThread(db, owner.id, created.id);
  const machine: Machine = { host: 'sprite', name: `agenthub-${created.id}`, url: 'http://127.0.0.1:9', token: null };
  return { owner, project: project as ProjectRow, thread, machine };
}

async function startRun(threadId: string): Promise<string> {
  const { data } = await db.from('runs').insert({ thread_id: threadId }).select('id').single().throwOnError();
  return data!.id;
}

const finishedRun = (threadId: string, status: string) => db.from('runs').insert({ thread_id: threadId, status }).throwOnError();

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

  const m: Machine = { host: 'sprite', name: 'agenthub-p', url: 'https://s', token: null };

  it('依回答分成 stopped / gone / unknown，帶資料庫通行證與 Fly 驗證', async () => {
    const stopped = answer(200, { stopped: true });
    expect(await askStop(m, 'r1', 'db', stopped)).toBe('stopped');
    const [url, init] = (stopped as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://s/runs/r1/stop');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { authorization: `Bearer ${env.spritesToken}`, 'x-agenthub-db-token': 'db' },
    });

    expect(await askStop(m, 'r1', 'db', answer(200, { stopped: false }))).toBe('gone');
    // 舊版 runtime 沒有這個路由，回 404，不能當成 run 已經不在
    expect(await askStop(m, 'r1', 'db', answer(404, {}))).toBe('unknown');
    expect(await askStop(m, 'r1', 'db', answer(200, { ok: true }))).toBe('unknown');
    const unreachable = vi.fn(async () => { throw new Error('連不上'); }) as unknown as typeof fetch;
    expect(await askStop(m, 'r1', 'db', unreachable)).toBe('unknown');
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
  it('上一輪正常完成時觸發 forward，不帶 text', async () => {
    const { owner, machine, thread } = await setup();
    await finishedRun(thread.id, 'succeeded');
    const forward = fakeForward();
    const view = await addQueued(db, owner.id, thread.id, '補充', { forward });

    expect(view).toEqual({ id: expect.any(String), text: '補充' });
    expect(forward).toHaveBeenCalledOnce();
    const [m, body, opts] = forward.mock.calls[0];
    expect(m).toEqual(machine);
    expect(body).toEqual({ thread_id: thread.id });
    expect(opts).toMatchObject({ projectToken: expect.any(String), dbToken: expect.any(String) });
  });

  it('有 running run 時不觸發 forward', async () => {
    const { owner, thread } = await setup();
    await startRun(thread.id);
    const forward = fakeForward();
    await addQueued(db, owner.id, thread.id, '補充', { forward });
    expect(forward).not.toHaveBeenCalled();
    expect(await queuedTexts(thread.id)).toEqual(['補充']);
  });

  it('上一則還在送出（chatPending）時不觸發 forward，由那一輪讀走', async () => {
    const { owner, thread } = await setup();
    const forward = fakeForward();
    await addQueued(db, owner.id, thread.id, '補充', { forward, chatPending: true });
    expect(forward).not.toHaveBeenCalled();
    expect(await queuedTexts(thread.id)).toEqual(['補充']);
  });

  it.each(['cancelled', 'failed'])('上一輪是 %s 時不自動開下一輪，訊息留給畫面放回輸入框', async (status) => {
    const { owner, thread } = await setup();
    await finishedRun(thread.id, status);
    const forward = fakeForward();
    await addQueued(db, owner.id, thread.id, '補充', { forward });
    expect(forward).not.toHaveBeenCalled();
    expect(await queuedTexts(thread.id)).toEqual(['補充']);
  });

  it('還沒有任何 run 時不觸發 forward', async () => {
    const { owner, thread } = await setup();
    const forward = fakeForward();
    await addQueued(db, owner.id, thread.id, '補充', { forward });
    expect(forward).not.toHaveBeenCalled();
  });

  it('defer：先回應，接續交給背景執行', async () => {
    const { owner, thread } = await setup();
    await finishedRun(thread.id, 'succeeded');
    const forward = fakeForward();
    let job: (() => Promise<void>) | undefined;
    const view = await addQueued(db, owner.id, thread.id, '補充', { forward, defer: (fn) => { job = fn; } });

    expect(view.text).toBe('補充');
    expect(forward).not.toHaveBeenCalled();
    await job!();
    expect(forward).toHaveBeenCalledOnce();
  });

  it('接續失敗不影響排隊結果，訊息留著', async () => {
    const { owner, thread } = await setup();
    await finishedRun(thread.id, 'succeeded');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await addQueued(db, owner.id, thread.id, '補充', { forward: vi.fn<typeof forwardChat>(async () => { throw new HttpError(500, '連不上'); }) });
    expect(view.text).toBe('補充');
    expect(await queuedTexts(thread.id)).toEqual(['補充']);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('別人的對話回 404，不寫入', async () => {
    const { thread } = await setup();
    const other = await seedUser(db);
    await expect(addQueued(db, other.id, thread.id, '補充', { forward: fakeForward() })).rejects.toMatchObject({ status: 404 });
    expect(await queuedTexts(thread.id)).toEqual([]);
  });
});

describe('editQueued、deleteQueued', () => {
  it('編輯與刪除排隊中的訊息', async () => {
    const { owner, thread } = await setup();
    await startRun(thread.id);
    const { id } = await addQueued(db, owner.id, thread.id, '原文', { forward: fakeForward() });
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
    const { id } = await addQueued(db, a.owner.id, a.thread.id, '原文', { forward: fakeForward() });
    await expect(editQueued(db, b.owner.id, b.thread.id, id, 'x')).rejects.toMatchObject({ status: 409 });
    expect(await queuedTexts(a.thread.id)).toEqual(['原文']);
  });
});

describe('startQueuedRun', () => {
  const queue = (threadId: string, text: string) => db.from('queued_messages').insert({ thread_id: threadId, text }).throwOnError();

  it('沒有排隊時不呼叫 forward', async () => {
    const { project, thread } = await setup();
    const forward = fakeForward();
    await startQueuedRun(db, project.id, thread.id, forward);
    expect(forward).not.toHaveBeenCalled();
  });

  it('forward 回 409 時不丟錯，排隊列保留', async () => {
    const { project, thread } = await setup();
    await queue(thread.id, '補充');
    await expect(startQueuedRun(db, project.id, thread.id, fakeForward(409))).resolves.toBeUndefined();
    expect(await queuedTexts(thread.id)).toEqual(['補充']);
  });

  it('forward 回 200 時取消回應內容，不等整輪跑完', async () => {
    const { project, thread } = await setup();
    await queue(thread.id, '補充');
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    await startQueuedRun(db, project.id, thread.id, vi.fn<typeof forwardChat>(async () => new Response(stream)));
    expect(cancel).toHaveBeenCalled();
  });

  it('forward 回其他錯誤時往外丟', async () => {
    const { project, thread } = await setup();
    await queue(thread.id, '補充');
    await expect(startQueuedRun(db, project.id, thread.id, fakeForward(500))).rejects.toBeInstanceOf(HttpError);
  });
});

describe('forwardToRuntime', () => {
  const body = { thread_id: 't', text: '你好' };
  const unreachable = () => new HttpError(502, 'agent 環境無法連線，請稍後再試（ECONNREFUSED）');

  async function e2bSetup() {
    const s = await setup();
    const machine: Machine = { host: 'e2b', name: 'sbx-1', url: 'https://8080-sbx-1.e2b.app', token: 'traffic-tok' };
    await db.from('projects').update({ host: 'e2b', sprite_name: 'sbx-1', sprite_url: machine.url, host_token: 'traffic-tok' })
      .eq('id', s.project.id).throwOnError();
    return { ...s, machine };
  }
  const projectState = async (id: string) =>
    (await db.from('projects').select('sprite_status, sprite_error').eq('id', id).single().throwOnError()).data;

  afterEach(() => { vi.unstubAllGlobals(); });

  it('E2B 專案轉送前先 extend 5 分鐘', async () => {
    const { project, machine } = await e2bSetup();
    const host = fakeRuntimeHost('e2b');
    const forward = fakeForward(200);
    const res = await forwardToRuntime(db, project.id, body, forward, () => host);

    expect(res.status).toBe(200);
    expect(host.extend).toHaveBeenCalledExactlyOnceWith(machine, 300_000);
    expect(host.extend.mock.invocationCallOrder[0]).toBeLessThan(forward.mock.invocationCallOrder[0]);
    // 轉送拿到完整的機器（含通行證），由 forwardChat 依它組邊緣標頭
    expect(forward.mock.calls[0][0]).toEqual(machine);
  });

  it('extend 失敗只警告，照樣轉送；Sprite 專案不 extend', async () => {
    const { project } = await e2bSetup();
    const host = fakeRuntimeHost('e2b');
    host.extend.mockRejectedValue(new Error('E2B API 500'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forward = fakeForward(200);
    expect((await forwardToRuntime(db, project.id, body, forward, () => host)).status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    const sprite = await setup();
    const spriteHost = fakeRuntimeHost('sprite');
    await forwardToRuntime(db, sprite.project.id, body, fakeForward(200), () => spriteHost);
    expect(spriteHost.extend).not.toHaveBeenCalled();
  });

  it('extend 回 gone：不轉送，直接標成 error 回 410', async () => {
    const { project } = await e2bSetup();
    const host = fakeRuntimeHost('e2b');
    host.extend.mockResolvedValue('gone');
    const forward = fakeForward(200);
    await expect(forwardToRuntime(db, project.id, body, forward, () => host)).rejects.toMatchObject({ status: 410, message: RUNTIME_GONE });
    expect(forward).not.toHaveBeenCalled();
    expect(await projectState(project.id)).toEqual({ sprite_status: 'error', sprite_error: RUNTIME_GONE });
  });

  it('轉送連不上且沙盒 gone：專案標成 error（RUNTIME_GONE），回 410', async () => {
    const { project, machine } = await e2bSetup();
    const host = fakeRuntimeHost('e2b');
    host.status.mockResolvedValue('gone');
    const forward = vi.fn<typeof forwardChat>(async () => { throw unreachable(); });

    const e = await forwardToRuntime(db, project.id, body, forward, () => host).catch((err) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 410, message: 'agent 環境已不存在，請重新建立' });
    expect(host.status).toHaveBeenCalledWith(machine);
    expect(host.startService).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledOnce();
    expect(await projectState(project.id)).toEqual({ sprite_status: 'error', sprite_error: RUNTIME_GONE });
  });

  it('轉送連不上但沙盒 running：重啟 runtime 服務一次再轉送', async () => {
    const { project, machine } = await e2bSetup();
    const host = fakeRuntimeHost('e2b');
    const health = stubHealth(project.id);
    const forward = vi.fn<typeof forwardChat>()
      .mockRejectedValueOnce(unreachable())
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await forwardToRuntime(db, project.id, body, forward, () => host);

    expect(res.status).toBe(200);
    // 冷開機後程序全沒了：以 installRuntime 相同的方式取得 runtime 目錄，重新啟動服務
    expect(host.exec).toHaveBeenCalledWith(machine, 'printf %s "$HOME"');
    expect(host.startService).toHaveBeenCalledExactlyOnceWith(machine, { name: 'runtime', cmd: '/usr/local/bin/agenthub-runtime', args: ['/home/user/agenthub'], httpPort: 8080 });
    // 等 runtime 起來（帶通行證）再轉送第二次
    expect(health).toHaveBeenCalledWith('https://8080-sbx-1.e2b.app/health', expect.objectContaining({ headers: { 'e2b-traffic-access-token': 'traffic-tok' } }));
    expect(forward).toHaveBeenCalledTimes(2);
    expect(await projectState(project.id)).toEqual({ sprite_status: 'ready', sprite_error: null });
  });

  it('重啟後仍連不上：照原本的錯誤回應，不再重啟', async () => {
    const { project } = await e2bSetup();
    const host = fakeRuntimeHost('e2b');
    stubHealth(project.id);
    const forward = vi.fn<typeof forwardChat>(async () => { throw unreachable(); });

    await expect(forwardToRuntime(db, project.id, body, forward, () => host)).rejects.toMatchObject({ status: 502 });
    expect(host.startService).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it('還沒有機器時回 409，不轉送', async () => {
    const { project } = await setup();
    await db.from('projects').update({ sprite_name: null, sprite_url: null }).eq('id', project.id).throwOnError();
    const forward = fakeForward(200);
    await expect(forwardToRuntime(db, project.id, body, forward, () => fakeRuntimeHost('sprite'))).rejects.toMatchObject({ status: 409 });
    expect(forward).not.toHaveBeenCalled();
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
