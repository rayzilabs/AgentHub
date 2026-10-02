import { describe, expect, it } from 'vitest';
import { safeNext } from '@/lib/safe-next';

describe('safeNext', () => {
  it('站內路徑原樣保留', () => {
    expect(safeNext('/projects')).toBe('/projects');
    expect(safeNext('/templates/abc?x=1')).toBe('/templates/abc?x=1');
    expect(safeNext('/')).toBe('/');
  });

  it('外部網址、// 與 /\\ 開頭、非字串都導回 /projects', () => {
    for (const v of ['//evil.com', '/\\evil.com', 'https://evil.com', 'projects', '', null, new File([], 'x')]) {
      expect(safeNext(v)).toBe('/projects');
    }
  });
});
