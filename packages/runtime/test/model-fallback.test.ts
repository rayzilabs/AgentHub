import { APICallError, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSY_ERROR, modelErrorText } from '../src/errors';
import { withFallbacks } from '../src/model-fallback';
import { errorAfterTextTurn, quotaError as busy, textTurn } from './mock-model';

const invalid = () => new APICallError({
  message: 'Invalid argument', url: 'https://platform/api/runtime/model', requestBodyValues: {}, statusCode: 400, isRetryable: false,
});

function model(modelId: string, answer: string | Error | ReturnType<typeof textTurn>) {
  return new MockLanguageModelV4({
    modelId,
    doStream: async () => {
      if (answer instanceof Error) throw answer;
      return typeof answer === 'string' ? textTurn(answer) : answer;
    },
  });
}

async function run(primary: MockLanguageModelV4, ...fallbacks: MockLanguageModelV4[]) {
  let error: unknown;
  const modelIds: string[] = [];
  const result = streamText({
    model: withFallbacks(primary, fallbacks),
    prompt: '你好',
    maxRetries: 0,
    onError: ({ error: e }) => { error = e; },
    onStepFinish: (step) => { modelIds.push(step.response.modelId); },
  });
  const text = await Promise.resolve(result.text).catch(() => '');
  return { text, error, modelIds };
}

describe('withFallbacks', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('主模型忙線（429）：改用第一個備援，回答備援的內容並記下實際回答的模型', async () => {
    const fallback = model('gemini-3.8-flash', '備援回答');
    const { text, modelIds } = await run(model('gemini-3.7-flash', busy()), fallback, model('gemini-3.5-flash', '不該用到'));
    expect(text).toBe('備援回答');
    expect(modelIds).toEqual(['gemini-3.8-flash']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gemini-3.7-flash → gemini-3.8-flash'));
  });

  it('主模型與第一個備援都忙線：改用第二個備援', async () => {
    const { text, modelIds } = await run(model('a', busy()), model('b', busy()), model('c', '第二備援'));
    expect(text).toBe('第二備援');
    expect(modelIds).toEqual(['c']);
  });

  it('全部忙線：丟出最後一個模型的錯誤，交給使用者時換成稍後再試', async () => {
    const last = busy();
    const { error } = await run(model('a', busy()), model('b', busy()), model('c', last));
    expect(error).toBe(last);
    expect(modelErrorText(error)).toBe(BUSY_ERROR);
  });

  it('不是忙線的錯誤（例如 400）：不換模型，原樣丟出', async () => {
    const bad = invalid();
    const fallback = model('b', '不該用到');
    const { error } = await run(model('a', bad), fallback);
    expect(error).toBe(bad);
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it('串流已經開始輸出後才出錯：不換模型', async () => {
    const fallback = model('b', '不該用到');
    const { error } = await run(model('a', errorAfterTextTurn('一半', 'RESOURCE_EXHAUSTED')), fallback);
    expect(String(error)).toContain('RESOURCE_EXHAUSTED');
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it('主模型正常：記下主模型的 id', async () => {
    const { text, modelIds } = await run(model('gemini-3.7-flash', '主模型回答'), model('b', '不該用到'));
    expect(text).toBe('主模型回答');
    expect(modelIds).toEqual(['gemini-3.7-flash']);
  });
});
