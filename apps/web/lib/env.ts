function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少環境變數 ${name}`);
  return value;
}

export const env = {
  get supabaseUrl() { return required('SUPABASE_URL'); },
  get supabasePublishableKey() { return required('SUPABASE_PUBLISHABLE_KEY'); },
  get supabaseSecretKey() { return required('SUPABASE_SECRET_KEY'); },
  get spritesToken() { return required('FLY_SPRITES_TOKEN'); },
  get vertexKey() { return required('VERTEX_API_EXPRESS_MODE_KEY'); },
  /** 未設定時不簽專案通行證（remote 型 MCP 無法使用，對話照常） */
  get runtimeTokenSecret() { return process.env.RUNTIME_TOKEN_SECRET || undefined; },
  get mcpSigningKey() { return required('MCP_SIGNING_KEY'); },
  get platformUrl() {
    if (process.env.PLATFORM_URL) return process.env.PLATFORM_URL;
    const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    // 在本機跑 redeploy-runtime 時也要寫入正式站網址，Sprite 才連得到閘道
    return vercel ? `https://${vercel}` : 'https://agenthub-kappa-pink.vercel.app';
  },
};
