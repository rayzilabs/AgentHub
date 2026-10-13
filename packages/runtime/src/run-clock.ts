/** 一次 run 的時間點（epoch 毫秒）。正式環境 15 分鐘；測試傳入較短的 runTimeoutMs 時等比例縮放 */
export type RunClock = {
  startedAt: number;
  /** 顧問停止用工具、主管不再派新工作 */
  consultantWrapUpAt: number;
  /** 顧問強制停止、主管停止用工具 */
  consultantStopAt: number;
  /** 單一顧問模式：顧問本身停止用工具 */
  soloWrapUpAt: number;
  runTimeoutAt: number;
};

export const TIME_UP = '剩餘時間不足，請用已有的結果彙整';

export function createRunClock(startedAt: number, runTimeoutMs: number): RunClock {
  const at = (fraction: number) => startedAt + Math.round(runTimeoutMs * fraction);
  return {
    startedAt,
    consultantWrapUpAt: at(11 / 15),
    consultantStopAt: at(13 / 15),
    soloWrapUpAt: at(13 / 15),
    runTimeoutAt: startedAt + runTimeoutMs,
  };
}
