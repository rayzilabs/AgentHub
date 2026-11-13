import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const env = {
  PROJECT_ID: '00000000-0000-4000-8000-000000000000',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'pk',
  PLATFORM_URL: 'https://platform',
};

describe('loadConfig', () => {
  it('預設主模型 gemini-3.7-flash，忙線時依序備援 3.8、3.5', () => {
    const config = loadConfig(env);
    expect(config.MODEL_ID).toBe('gemini-3.7-flash');
    expect(config.MODEL_FALLBACKS).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash']);
  });

  it('備援清單可用逗號分隔覆寫，空字串代表不備援', () => {
    expect(loadConfig({ ...env, MODEL_FALLBACKS: ' a , b ' }).MODEL_FALLBACKS).toEqual(['a', 'b']);
    expect(loadConfig({ ...env, MODEL_FALLBACKS: '' }).MODEL_FALLBACKS).toEqual([]);
  });
});
