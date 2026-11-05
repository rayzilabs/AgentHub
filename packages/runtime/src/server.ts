import { Hono } from 'hono';
import { z } from 'zod';
import { activeRuns } from './active-runs';
import { errorText, NotFoundError, RunConflictError } from './errors';
import { startRun, type RunDeps } from './run';

// 沒有 text 代表平台要接續排隊訊息
const ChatBody = z.object({ thread_id: z.uuid(), text: z.string().min(1).optional() });

export function createApp(deps: RunDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, project_id: deps.config.PROJECT_ID }));

  // 用平台附上的資料庫通行證查這個 run：Supabase 驗證通行證、RLS 只放行本專案，
  // 查得到才代表是本專案的平台在問（Sprite 上沒有驗證專案通行證的密鑰）
  const runAccessError = async (dbToken: string | undefined, id: string): Promise<string | null> => {
    if (!dbToken) return '缺少資料庫通行證';
    const { data, error } = await deps.openDb(dbToken).from('runs').select('id').eq('id', id).maybeSingle();
    return error || !data ? '查不到這個 run' : null;
  };

  // 平台確認 run 是否還活著
  app.get('/runs/:id', async (c) => {
    const id = c.req.param('id');
    const denied = await runAccessError(c.req.header('x-agenthub-db-token'), id);
    if (denied) return c.json({ error: denied }, 401);
    return c.json({ active: activeRuns.has(id) });
  });

  // stopped=false 代表這個程序沒有這個 run；重複按停止時 run 還在收尾，仍回 true
  app.post('/runs/:id/stop', async (c) => {
    const id = c.req.param('id');
    const denied = await runAccessError(c.req.header('x-agenthub-db-token'), id);
    if (denied) return c.json({ error: denied }, 401);
    const stop = activeRuns.get(id);
    stop?.();
    return c.json({ stopped: stop !== undefined });
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
