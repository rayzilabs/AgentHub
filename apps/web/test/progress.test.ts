import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { currentActivity, elapsedOf, foldSteps, formatElapsed, isStalled, stepOf } from '@/lib/progress';

const assistant = (parts: unknown[], metadata?: unknown) => ({ id: 'a', role: 'assistant', parts, metadata }) as unknown as UIMessage;

describe('formatElapsed', () => {
  it('10 秒內一位小數、1 分鐘內整數秒、之後 分:秒', () => {
    expect(formatElapsed(200)).toBe('0.2s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(105_000)).toBe('1:45');
    expect(formatElapsed(-50)).toBe('0.0s');
  });
});

describe('elapsedOf', () => {
  it('結束的步驟用結束時間；執行中用現在；沒有開始時間回傳 undefined', () => {
    const t0 = '2026-10-13T00:00:00.000Z';
    expect(elapsedOf({ tool: 'bash', state: 'output-available', started_at: t0, ended_at: '2026-10-13T00:00:12.000Z' }, 0)).toBe(12_000);
    expect(elapsedOf({ tool: 'bash', state: 'input-available', started_at: t0 }, Date.parse(t0) + 3_000)).toBe(3_000);
    expect(elapsedOf({ tool: 'bash', state: 'output-available' }, 0)).toBeUndefined();
  });
});

describe('foldSteps', () => {
  it('8 步以內全顯示；超過時只留最新 5 步', () => {
    expect(foldSteps([1, 2, 3])).toEqual({ hidden: 0, visible: [1, 2, 3] });
    expect(foldSteps([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual({ hidden: 4, visible: [5, 6, 7, 8, 9] });
  });
});

describe('stepOf', () => {
  it('從 tool part 與 metadata 組出步驟', () => {
    const part = { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: { command: 'x', description: '計算評等' } };
    const metadata = { tool_times: { c1: { started_at: 'S', ended_at: 'E' } } };
    expect(stepOf(part, metadata)).toEqual({ tool: 'bash', state: 'output-available', description: '計算評等', started_at: 'S', ended_at: 'E' });
  });

  it('舊資料沒有描述與時間：只有動作名稱與狀態', () => {
    expect(stepOf({ type: 'dynamic-tool', toolName: 'finmind__price', toolCallId: 'c1', state: 'input-available', input: {} }, undefined))
      .toEqual({ tool: 'finmind__price', state: 'input-available' });
  });
});

describe('currentActivity', () => {
  it('沒有訊息或沒有在跑的工具：思考中；最後一段是文字：正在撰寫回覆', () => {
    expect(currentActivity(undefined)).toBe('思考中');
    expect(currentActivity(assistant([{ type: 'step-start' }]))).toBe('思考中');
    expect(currentActivity(assistant([{ type: 'text', text: '結論' }]))).toBe('正在撰寫回覆');
  });

  it('派工中：正在等顧問；討論中：第幾輪', () => {
    expect(currentActivity(assistant([
      { type: 'tool-assign_task', toolCallId: 'c1', state: 'output-available', preliminary: true, output: { name: 'ETF 資金流顧問', status: 'working' } },
    ]))).toBe('正在等ETF 資金流顧問');
    expect(currentActivity(assistant([
      { type: 'tool-convene_discussion', toolCallId: 'c1', state: 'output-available', preliminary: true, output: { round: 2, speeches: [] } },
    ]))).toBe('第 2 輪討論');
  });

  it('一般工具：有描述用描述，沒有就用動作名稱', () => {
    expect(currentActivity(assistant([
      { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: { command: 'a' } },
      { type: 'tool-bash', toolCallId: 'c2', state: 'input-available', input: { command: 'b', description: '安裝數值計算套件' } },
    ]))).toBe('安裝數值計算套件');
    expect(currentActivity(assistant([
      { type: 'tool-read_file', toolCallId: 'c1', state: 'input-available', input: { path: 'a' } },
    ]))).toBe('正在讀取檔案');
  });
});

describe('isStalled', () => {
  it('超過門檻才算卡住；沒有更新時間不判斷', () => {
    const now = Date.parse('2026-10-13T00:02:00Z');
    expect(isStalled('2026-10-13T00:00:30Z', now)).toBe(true);
    expect(isStalled('2026-10-13T00:01:30Z', now)).toBe(false);
    expect(isStalled(null, now)).toBe(false);
  });
});
