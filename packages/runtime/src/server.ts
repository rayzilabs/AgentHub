import { Hono } from 'hono';
import { z } from 'zod';
import { errorText, NotFoundError, RunConflictError } from './errors';
import { startRun, type RunDeps } from './run';

const ChatBody = z.object({ thread_id: z.uuid(), text: z.string().min(1) });

export function createApp(deps: RunDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, project_id: deps.config.PROJECT_ID }));

  app.post('/chat', async (c) => {
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '請求格式錯誤' }, 400);
    try {
      return await startRun(deps, { threadId: parsed.data.thread_id, text: parsed.data.text });
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof RunConflictError) return c.json({ error: e.message }, 409);
      return c.json({ error: errorText(e) }, 500);
    }
  });

  return app;
}
