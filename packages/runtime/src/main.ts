import { createVertex } from '@ai-sdk/google-vertex';
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createDb } from './db';
import { errorText } from './errors';
import { failRunningRuns } from './run-store';
import { createApp } from './server';

const config = loadConfig();
const db = createDb(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY);
const vertex = createVertex({ apiKey: config.VERTEX_API_EXPRESS_MODE_KEY });

try {
  const cleaned = await failRunningRuns(db, config.PROJECT_ID, 'runtime 重啟');
  if (cleaned > 0) console.warn(`[startup] 已把 ${cleaned} 個中斷的 run 標成 failed`);
} catch (e) {
  // 清理失敗不該讓服務起不來（否則會一直重啟）；殘留的 running run 下次重啟再清
  console.error('[startup] 無法清理中斷的 run', errorText(e));
}

serve({ fetch: createApp({ db, model: vertex(config.MODEL_ID), config }).fetch, port: config.PORT }, (info) => {
  console.log(`[runtime] listening on :${info.port}，專案 ${config.PROJECT_ID}`);
});
