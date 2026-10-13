import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { progressSaver } from '../src/progress';
import { textOf } from '../src/ui-stream';

const msg = (text: string): UIMessage => ({ id: 'm', role: 'assistant', parts: [{ type: 'text', text }] });
const empty: UIMessage = { id: 'm', role: 'assistant', parts: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noop = async () => {};

describe('progressSaver', () => {
  it('第一份有內容的快照立刻存，之後依間隔節流；空白快照不存', async () => {
    const saved: string[] = [];
    const p = progressSaver({ save: async (m) => { saved.push(textOf(m)); }, touch: noop, intervalMs: 50, heartbeatMs: 10_000 });
    p.offer(empty);
    p.offer(msg('A'));
    p.offer(msg('AB'));
    await sleep(60);
    p.offer(msg('ABC'));
    await p.stop();
    expect(saved).toEqual(['A', 'ABC']);
    expect(p.saved).toBe(true);
  });

  it('依序寫入：前一筆還沒寫完不會並行', async () => {
    let active = 0;
    let maxActive = 0;
    const p = progressSaver({
      save: async () => { active++; maxActive = Math.max(maxActive, active); await sleep(20); active--; },
      touch: noop, intervalMs: 0, heartbeatMs: 10_000,
    });
    p.offer(msg('A'));
    p.offer(msg('B'));
    p.offer(msg('C'));
    await p.stop();
    expect(maxActive).toBe(1);
  });

  it('定期送心跳；stop 之後不再送，也不再接受快照', async () => {
    const touch = vi.fn(noop);
    const save = vi.fn(noop);
    const p = progressSaver({ save, touch, intervalMs: 0, heartbeatMs: 20 });
    await sleep(70);
    await p.stop();
    const n = touch.mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(2);
    p.offer(msg('太晚了'));
    await sleep(50);
    expect(touch.mock.calls.length).toBe(n);
    expect(save).not.toHaveBeenCalled();
  });

  it('寫入失敗只記 log，不丟例外，saved 維持 false', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = progressSaver({ save: async () => { throw new Error('DB 斷線'); }, touch: noop, intervalMs: 0, heartbeatMs: 10_000 });
      p.offer(msg('A'));
      await p.stop();
      expect(p.saved).toBe(false);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
