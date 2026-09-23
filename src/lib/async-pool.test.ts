import { describe, expect, it, vi } from 'vitest';

import { mapWithConcurrency } from './async-pool';

/** A manually-settled promise — the same deferred pattern as the Tier 1
 *  concurrency test in `holdings/live-view.test.ts`. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('mapWithConcurrency', () => {
  it('never exceeds the limit in flight, and starts items in input order', async () => {
    const gates = Array.from({ length: 7 }, () => deferred<void>());
    let inFlight = 0;
    let maxInFlight = 0;
    const started: number[] = [];

    const result = mapWithConcurrency(
      [0, 1, 2, 3, 4, 5, 6],
      3,
      async (item, index) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(index);
        await gates[index].promise;
        inFlight--;
        return item * 10;
      },
    );

    await tick();
    // Exactly the first `limit` items are running; none past the bound.
    expect(started).toEqual([0, 1, 2]);
    expect(maxInFlight).toBe(3);

    // Releasing one admits exactly one more, in input order.
    gates[1].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(maxInFlight).toBe(3);

    for (const gate of gates) gate.resolve();
    await result;
    expect(maxInFlight).toBe(3);
  });

  it('returns results in input order even when resolution order is reversed', async () => {
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const result = mapWithConcurrency(['a', 'b', 'c', 'd'], 4, async (item, index) => {
      await gates[index].promise;
      return item.toUpperCase();
    });

    // Settle strictly back to front.
    for (const gate of [...gates].reverse()) {
      gate.resolve();
      await tick();
    }
    expect(await result).toEqual(['A', 'B', 'C', 'D']);
  });

  it('processes every item exactly once, with its ORIGINAL index', async () => {
    const seen: [string, number][] = [];
    const result = await mapWithConcurrency(['p', 'q', 'r', 's', 't'], 2, async (item, index) => {
      seen.push([item, index]);
      return index;
    });

    expect(result).toEqual([0, 1, 2, 3, 4]);
    expect([...seen].sort((a, b) => a[1] - b[1])).toEqual([
      ['p', 0],
      ['q', 1],
      ['r', 2],
      ['s', 3],
      ['t', 4],
    ]);
    expect(seen).toHaveLength(5);
  });

  it('propagates a rejection from fn (documented: pooled tasks are never-throw by contract)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
  });

  it('empty input resolves to [] without calling fn at all', async () => {
    const fn = vi.fn(async (item: number) => item);
    expect(await mapWithConcurrency([], 3, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('limit ≥ items.length runs everything at once and completes', async () => {
    const gates = Array.from({ length: 3 }, () => deferred<void>());
    let inFlight = 0;
    let maxInFlight = 0;
    const result = mapWithConcurrency([1, 2, 3], 10, async (item, index) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[index].promise;
      inFlight--;
      return item;
    });

    await tick();
    expect(maxInFlight).toBe(3); // all admitted — the bound is items.length
    for (const gate of gates) gate.resolve();
    expect(await result).toEqual([1, 2, 3]);
  });

  it('limit = 1 degrades to a strictly sequential walk', async () => {
    const order: string[] = [];
    await mapWithConcurrency(['x', 'y', 'z'], 1, async (item) => {
      order.push(`start-${item}`);
      await tick();
      order.push(`end-${item}`);
      return item;
    });

    expect(order).toEqual(['start-x', 'end-x', 'start-y', 'end-y', 'start-z', 'end-z']);
  });

  it('a sub-1 or fractional limit still makes progress (floored to at least 1)', async () => {
    expect(await mapWithConcurrency([1, 2], 0, async (item) => item)).toEqual([1, 2]);
    expect(await mapWithConcurrency([1, 2, 3], 2.7, async (item) => item)).toEqual([1, 2, 3]);
  });

  it('a non-finite limit runs every item rather than silently returning holes', async () => {
    // The dangerous shape: NaN used to spawn zero workers and resolve to a
    // full-length array of `undefined` — a successful-looking result with no
    // work done. Assert the RESULTS, and that fn actually ran per item.
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const fn = vi.fn(async (item: number) => item * 2);
      expect(await mapWithConcurrency([1, 2, 3], limit, fn)).toEqual([2, 4, 6]);
      expect(fn).toHaveBeenCalledTimes(3);
    }
  });
});
