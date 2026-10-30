import { Hono } from 'hono';
import { z } from 'zod';
import { activeRuns } from './active-runs';
import { errorText, NotFoundError, RunConflictError } from './errors';
import { startRun, type RunDeps } from './run';

const ChatBody = z.object({ thread_id: z.uuid(), text: z.string().min(1) });

export function createApp(deps: RunDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, project_id: deps.config.PROJECT_ID }));

  // 平台確認 run 是否還活著。用平台附上的資料庫通行證查這個 run：Supabase 驗證通行證、RLS 只放行本專案，
  // 查得到才代表是本專案的平台在問（Sprite 上沒有驗證專案通行證的密鑰）
  app.get('/runs/:id', async (c) => {
    const dbToken = c.req.header('x-agenthub-db-token');
    if (!dbToken) return c.json({ error: '缺少資料庫通行證' }, 401);
    const id = c.req.param('id');
    const { data, error } = await deps.openDb(dbToken).from('runs').select('id').eq('id', id).maybeSingle();
    if (error || !data) return c.json({ error: '查不到這個 run' }, 401);
    return c.json({ active: activeRuns.has(id) });
  });

  app.post('/chat', async (c) => {
    const dbToken = c.req.header('x-agenthub-db-token');
    if (!dbToken) return c.json({ error: '缺少資料庫通行證' }, 401);
    const platformToken = c.req.header('x-agenthub-token');
    if (!platformToken) return c.json({ error: '缺少專案通行證' }, 401);
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '請求格式錯誤' }, 400);
    try {
      return await startRun(deps, {
        threadId: parsed.data.thread_id,
        text: parsed.data.text,
        platformToken,
        dbToken,
      });
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof RunConflictError) return c.json({ error: e.message }, 409);
      return c.json({ error: errorText(e) }, 500);
    }
  });

  return app;
}
