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
};
