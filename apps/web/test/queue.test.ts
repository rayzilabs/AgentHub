import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { afterRun, readIds, restoredInput } from '@/lib/queue';

const item = { id: 'q1', text: '補充' };

describe('afterRun', () => {
  it('沒有排隊 → none', () => {
    expect(afterRun({ running: false, runStatus: 'succeeded', queued: [] })).toBe('none');
    expect(afterRun({ running: false, runStatus: 'cancelled', queued: [] })).toBe('none');
  });

  it('還在跑 → wait；正常完成 → wait，伺服器會自己開下一輪', () => {
    expect(afterRun({ running: true, runStatus: 'running', queued: [item] })).toBe('wait');
    expect(afterRun({ running: false, runStatus: 'succeeded', queued: [item] })).toBe('wait');
  });

  it('失敗、中斷或還沒有任何 run → restore', () => {
    expect(afterRun({ running: false, runStatus: 'failed', queued: [item] })).toBe('restore');
    expect(afterRun({ running: false, runStatus: 'cancelled', queued: [item] })).toBe('restore');
    expect(afterRun({ running: false, runStatus: null, queued: [item] })).toBe('restore');
  });
});

describe('restoredInput', () => {
  it('保留現有文字，排隊內容以空行接在後面', () => {
    expect(restoredInput('還沒送出', [{ id: 'a', text: '第一則' }, { id: 'b', text: '第二則' }])).toBe('還沒送出\n\n第一則\n\n第二則');
  });

  it('輸入框是空的時不留空行', () => {
    expect(restoredInput('', [{ id: 'a', text: '第一則' }])).toBe('第一則');
  });
});

describe('readIds', () => {
  it('只取 data-interjection', () => {
    const messages = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Q' }] },
      {
        id: 'a', role: 'assistant',
        parts: [
          { type: 'data-warning', data: { text: '提醒' } },
          { type: 'data-interjection', id: 'q1', data: { id: 'q1', text: '補充' } },
          { type: 'text', text: 'A' },
        ],
      },
    ] as UIMessage[];
    expect(readIds(messages)).toEqual(new Set(['q1']));
  });
});
