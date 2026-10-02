import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// 本機從 repo 根目錄 .env 讀環境變數（Node 26 下 `node --env-file` 會被 Next 轉進
// NODE_OPTIONS 而被拒絕）；Vercel 上沒有這個檔案，直接用專案設定的變數。
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = { agentRules: false };

export default nextConfig;
