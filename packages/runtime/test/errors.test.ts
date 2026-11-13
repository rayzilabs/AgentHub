import { RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { BUSY_ERROR, modelErrorText } from '../src/errors';
import { quotaError as quota } from './mock-model';


describe('modelErrorText', () => {
  it('模型配額用完（429／Resource exhausted）：改成請使用者稍後再試', () => {
    // 2026-10-30 正式站課程尖峰：3 次對話失敗，錯誤是「Failed after 4 attempts. Last error: … Resource exhausted」
    expect(modelErrorText(new RetryError({ message: 'Failed after 4 attempts. Last error: Resource exhausted.', reason: 'maxRetriesExceeded', errors: [quota()] }))).toBe(BUSY_ERROR);
    expect(modelErrorText(quota())).toBe(BUSY_ERROR);
    expect(modelErrorText(new Error('[GoogleGenerativeAI] RESOURCE_EXHAUSTED: quota'))).toBe(BUSY_ERROR);
    expect(BUSY_ERROR).toContain('目前使用人數較多，請稍後再試');
  });

  it('其他錯誤照原樣', () => {
    expect(modelErrorText(new Error('boom'))).toBe('boom');
    expect(modelErrorText('x')).toBe('x');
  });
});
