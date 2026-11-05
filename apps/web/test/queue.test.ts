import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { afterRun, ALREADY_READ, chatInFlight, readIds, reclaimQueued, restoredInput } from '@/lib/queue';

const item = { id: 'q1', text: '補充' };

describe('chatInFlight', () => {
  it('只有串流進行中才不需要另外看伺服器', () => {
    expect(chatInFlight('submitted')).toBe(true);
    expect(chatInFlight('streaming')).toBe(true);
    expect(chatInFlight('ready')).toBe(false);
    expect(chatInFlight('error')).toBe(false);
  });
});

describe('reclaimQueued', () => {
  const a = { id: 'a', text: '第一則' };
  const b = { id: 'b', text: '第二則' };
  const c = { id: 'c', text: '第三則' };

  it('刪成功的才放回；已被讀取的不放回，否則會同時出現在回覆和輸入框', async () => {
    const del = async (id: string) => { if (id === 'b') throw new Error(ALREADY_READ); };
    expect(await reclaimQueued([a, b, c], del)).toEqual([a, c]);
  });

  it('其他失敗照放回：訊息不能因為網路問題消失', async () => {
    const del = async () => { throw new Error('網路連線中斷，請稍後再試'); };
    expect(await reclaimQueued([a], del)).toEqual([a]);
  });
});

describe('afterRun', () => {
  it('沒有排隊 → none', () => {
    expect(afterRun({ running: false, runStatus: 'succeeded', queued: [] })).toBe('none');
    expect(afterRun({ running: false, runStatus: 'cancelled', queued: [] })).toBe('none');
  });

  it('還在跑 → wait；正常完成 → wait，伺服器會自己開下一輪', () => {
    expect(afterRun({ running: true, runStatus: 'running', queued: [item] })).toBe('wait');
    expect(afterRun({ running: false, runStatus: 'succeeded', queued: [item] })).toBe('wait');
  });

  it('使用者要停止時，正常完成也不等下一輪；還在跑的要先等它停', () => {
    expect(afterRun({ running: false, runStatus: 'succeeded', queued: [item] }, true)).toBe('restore');
    expect(afterRun({ running: true, runStatus: 'running', queued: [item] }, true)).toBe('wait');
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
