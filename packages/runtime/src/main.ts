import { createVertex } from '@ai-sdk/google-vertex';
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createDb } from './db';
import { failRunningRuns } from './run-store';
import { createApp } from './server';

const config = loadConfig();
const db = createDb(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY);
const vertex = createVertex({ apiKey: config.VERTEX_API_EXPRESS_MODE_KEY });

const cleaned = await failRunningRuns(db, config.PROJECT_ID, 'runtime 重啟');
if (cleaned > 0) console.warn(`[startup] 已把 ${cleaned} 個中斷的 run 標成 failed`);

serve({ fetch: createApp({ db, model: vertex(config.MODEL_ID), config }).fetch, port: config.PORT }, (info) => {
  console.log(`[runtime] listening on :${info.port}，專案 ${config.PROJECT_ID}`);
});
