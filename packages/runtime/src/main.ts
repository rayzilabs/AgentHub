import { createVertex } from '@ai-sdk/google-vertex';
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createDb } from './db';
import { errorText } from './errors';
import { failRunningRuns } from './run-store';
import { checkSandboxUser, ensureSocketLocked } from './sandbox';
import { createApp } from './server';

const config = loadConfig();

// 沙盒帳號與 runtime 共用工作區，新檔案要讓同群組可寫
process.umask(0o002);

if (config.SANDBOX_USER) {
  const check = await checkSandboxUser(config.SANDBOX_USER);
  if (!check.ok) {
    // 寧可起不來，也不要在沒有隔離的狀態下替 agent 執行指令
    console.error(`[startup] 沙盒帳號 ${config.SANDBOX_USER} 無法使用：${check.error}`);
    process.exit(1);
  }
  const lock = await ensureSocketLocked(config.SPRITE_API_SOCK, process.getgid!());
  if (!lock.ok) {
    console.error(`[startup] 無法收緊 Sprite 內部 API 的權限：${lock.error}`);
    process.exit(1);
  }
}
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
