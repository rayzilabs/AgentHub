import { describe, expect, it } from 'vitest';
import { createRunClock } from '../src/run-clock';
import { RUN_TIMEOUT_MS } from '../src/run';

describe('createRunClock', () => {
  it('正式環境：11 分顧問收尾、13 分強制停止與主管收尾、15 分上限', () => {
    expect(createRunClock(0, RUN_TIMEOUT_MS)).toEqual({
      startedAt: 0, consultantWrapUpAt: 660_000, consultantStopAt: 780_000, soloWrapUpAt: 780_000, runTimeoutAt: 900_000,
    });
  });

  it('測試用的短時間依比例縮放', () => {
    expect(createRunClock(1_000, 1_500)).toEqual({
      startedAt: 1_000, consultantWrapUpAt: 2_100, consultantStopAt: 2_300, soloWrapUpAt: 2_300, runTimeoutAt: 2_500,
    });
  });
});
