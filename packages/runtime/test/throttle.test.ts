import { describe, expect, it } from 'vitest';
import { throttle } from '../src/throttle';

async function* source(values: number[], delayMs: number) {
  for (const v of values) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield v;
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('throttle', () => {
  it('快速連續的值會被合併，最後一個值一定送出', async () => {
    const out = await collect(throttle(source([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5), 40));
    expect(out.length).toBeLessThan(10);
    expect(out[0]).toBe(1);
    expect(out.at(-1)).toBe(10);
  });

  it('間隔夠長時每個值都送出', async () => {
    expect(await collect(throttle(source([1, 2, 3], 30), 10))).toEqual([1, 2, 3]);
  });

  it('送出的是副本，之後修改來源物件不影響已送出的值', async () => {
    const shared = { n: 0 };
    async function* mutating() {
      shared.n = 1;
      yield shared;
      await new Promise((r) => setTimeout(r, 20));
      shared.n = 2;
      yield shared;
    }
    const out = await collect(throttle(mutating(), 5));
    expect(out.map((o) => o.n)).toEqual([1, 2]);
  });

  it('來源丟錯時往外拋', async () => {
    async function* failing() {
      yield 1;
      throw new Error('壞了');
    }
    await expect(collect(throttle(failing(), 5))).rejects.toThrow('壞了');
  });
});
