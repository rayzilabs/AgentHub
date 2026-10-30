import { createVertex } from '@ai-sdk/google-vertex';
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createUserDb } from './db';
import { imageFetch } from './image-rewrite';
import type { ImageRegistry } from './images';
import { checkSandboxUser } from './sandbox';
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
}
// Sprite 上不放平台金鑰：資料庫用 Vercel 每次附上的 runtime 帳號通行證，模型經平台代理（Vertex 金鑰只在 Vercel）
const openDb = (dbToken: string) => createUserDb(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, dbToken);
const modelFor = (platformToken: string | undefined, images?: ImageRegistry) =>
  // express mode 把 apiKey 放在 x-goog-api-key；這裡放的是專案通行證，由代理驗證後換成真的 Vertex 金鑰
  createVertex({
    apiKey: platformToken ?? '',
    baseURL: `${config.PLATFORM_URL}/api/runtime/model`,
    fetch: images ? imageFetch(images.urlFor) : undefined,
  })(config.MODEL_ID);

serve({ fetch: createApp({ openDb, modelFor, config }).fetch, port: config.PORT }, (info) => {
  console.log(`[runtime] listening on :${info.port}，專案 ${config.PROJECT_ID}`);
});
