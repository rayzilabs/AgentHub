import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askRuntime, markRunInterrupted, shouldAsk } from '@/lib/run-liveness';
import { createProject } from '@/lib/services/projects';
import { createThread, getThreadMessages } from '@/lib/services/threads';
import { seedUser, testDb } from './helpers';

const db = testDb();

describe('run 存活確認', () => {
  let server: Server;
  let base: string;
  const seen: { url?: string; headers: IncomingHttpHeaders }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      const reply = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      if (req.url === '/runs/a') return reply(200, { active: true });
      if (req.url === '/runs/g') return reply(200, { active: false });
      if (req.url === '/runs/e') return reply(500, { error: 'x' });
      if (req.url === '/runs/odd') return reply(200, { ok: true });
      if (req.url === '/runs/slow') { setTimeout(() => reply(200, { active: false }), 6_000); return; }
      reply(404, {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('askRuntime：依 Sprite 回答分成 active / gone / unknown，帶上資料庫通行證', async () => {
    expect(await askRuntime(base, 'a', 't')).toBe('active');
    expect(seen.at(-1)?.headers['x-agenthub-db-token']).toBe('t');
    expect(await askRuntime(base, 'g', 't')).toBe('gone');
    expect(await askRuntime(base, 'e', 't')).toBe('unknown');
    expect(await askRuntime(base, 'odd', 't')).toBe('unknown');
    expect(await askRuntime('http://127.0.0.1:1', 'a', 't')).toBe('unknown');
  });

  it('askRuntime：Sprite 超過 5 秒沒回應視為無法判斷', async () => {
    expect(await askRuntime(base, 'slow', 't')).toBe('unknown');
  }, 10_000);

  it('shouldAsk：同一個 run 15 秒內只問一次', () => {
    expect(shouldAsk('r1', 0)).toBe(true);
    expect(shouldAsk('r1', 14_999)).toBe(false);
    expect(shouldAsk('r1', 15_000)).toBe(true);
    expect(shouldAsk('r2', 15_000)).toBe(true);
  });

  async function setup() {
    const owner = await seedUser(db);
    const project = await createProject(db, owner.id, 'p');
    const thread = await createThread(db, owner.id, project.id);
    return { owner, project, thread };
  }

  it('markRunInterrupted 只改仍是 running 的 run', async () => {
    const { thread } = await setup();
    const { data: running } = await db.from('runs').insert({ thread_id: thread.id }).select('id').single();
    const { data: done } = await db.from('runs').insert({ thread_id: thread.id, status: 'succeeded' }).select('id').single();
    expect(await markRunInterrupted(db, running!.id)).toBe(true);
    expect(await markRunInterrupted(db, done!.id)).toBe(false);
    const { data: rows } = await db.from('runs').select('id, status, error, finished_at').in('id', [running!.id, done!.id]);
    const byId = Object.fromEntries(rows!.map((r) => [r.id, r]));
    expect(byId[running!.id]).toMatchObject({ status: 'failed', error: '執行環境中斷' });
    expect(byId[running!.id].finished_at).toBeTruthy();
    expect(byId[done!.id]).toMatchObject({ status: 'succeeded', error: null });
  });

  it('getThreadMessages：Sprite 說不知道這個 run → 標成中斷；active 或無法判斷 → 照舊顯示執行中', async () => {
    const { owner, project, thread } = await setup();
    await db.from('projects').update({ sprite_status: 'ready', sprite_url: 'https://sprite.example' }).eq('id', project.id);
    const { data: run } = await db.from('runs').insert({ thread_id: thread.id }).select('id').single();
    const asked: string[] = [];
    const check = (answer: 'active' | 'gone' | 'unknown') => async (spriteUrl: string, runId: string) => {
      asked.push(`${spriteUrl} ${runId}`);
      return answer;
    };

    expect(await getThreadMessages(db, owner.id, thread.id, check('active'))).toMatchObject({ running: true, error: null });
    expect(await getThreadMessages(db, owner.id, thread.id, check('unknown'))).toMatchObject({ running: true, error: null });
    const r = await getThreadMessages(db, owner.id, thread.id, check('gone'));
    expect(r).toMatchObject({ running: false, error: '執行環境中斷' });
    expect(asked).toEqual([`https://sprite.example ${run!.id}`, `https://sprite.example ${run!.id}`, `https://sprite.example ${run!.id}`]);
    expect((await db.from('runs').select('status').eq('id', run!.id).single()).data!.status).toBe('failed');
  });

  it('getThreadMessages：專案沒有 sprite_url 時不問', async () => {
    const { owner, thread } = await setup();
    await db.from('runs').insert({ thread_id: thread.id });
    let asked = false;
    await getThreadMessages(db, owner.id, thread.id, async () => { asked = true; return 'gone'; });
    expect(asked).toBe(false);
  });
});
