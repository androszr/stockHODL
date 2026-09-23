import { describe, expect, it } from 'vitest';

import {
  MAX_INSTRUMENTS_PER_RUN,
  planBackfillRun,
  WATCHED_RESERVED_SLOTS,
} from './backfill-budget';

/** n labelled rows — the helper is generic, symbols are all it needs here. */
function rows(prefix: string, n: number): { symbol: string }[] {
  return Array.from({ length: n }, (_, i) => ({ symbol: `${prefix}${i}` }));
}

describe('planBackfillRun — the reserved watched slice', () => {
  it('50 held + 10 watched → 40 held + 10 watched: watched are never starved (the reviewed defect)', () => {
    // The pre-fix behaviour: `[...held, ...watched].slice(0, 50)` served all
    // 50 held and ZERO watched, forever, silently.
    const held = rows('H', 50);
    const watched = rows('W', 10);
    const plan = planBackfillRun(held, watched);
    expect(plan.take).toHaveLength(MAX_INSTRUMENTS_PER_RUN);
    expect(plan.take.slice(0, 40)).toEqual(held.slice(0, 40));
    expect(plan.take.slice(40)).toEqual(watched);
    expect(plan.droppedHeld).toEqual(held.slice(40));
    expect(plan.droppedWatched).toEqual([]);
  });

  it('55 held + 3 watched → 47 + 3: the slack reservation returns to held', () => {
    const held = rows('H', 55);
    const watched = rows('W', 3);
    const plan = planBackfillRun(held, watched);
    expect(plan.take).toHaveLength(MAX_INSTRUMENTS_PER_RUN);
    expect(plan.take.slice(0, 47)).toEqual(held.slice(0, 47));
    expect(plan.take.slice(47)).toEqual(watched);
    expect(plan.droppedHeld).toHaveLength(8);
    expect(plan.droppedWatched).toEqual([]);
  });

  it('20 held + 40 watched → 20 + 30: unused held budget flows to watched', () => {
    const held = rows('H', 20);
    const watched = rows('W', 40);
    const plan = planBackfillRun(held, watched);
    expect(plan.take).toHaveLength(MAX_INSTRUMENTS_PER_RUN);
    expect(plan.take.slice(0, 20)).toEqual(held);
    expect(plan.take.slice(20)).toEqual(watched.slice(0, 30));
    expect(plan.droppedHeld).toEqual([]);
    expect(plan.droppedWatched).toEqual(watched.slice(30));
  });

  it('5 held + 2 watched → everything taken, both dropped arrays empty', () => {
    const held = rows('H', 5);
    const watched = rows('W', 2);
    const plan = planBackfillRun(held, watched);
    expect(plan.take).toEqual([...held, ...watched]);
    expect(plan.droppedHeld).toEqual([]);
    expect(plan.droppedWatched).toEqual([]);
  });

  it('preserves order: held before watched, each group in input order', () => {
    const held = [{ symbol: 'ZZZ' }, { symbol: 'AAA' }, { symbol: 'MMM' }];
    const watched = [{ symbol: 'YYY' }, { symbol: 'BBB' }];
    const plan = planBackfillRun(held, watched);
    expect(plan.take.map((r) => r.symbol)).toEqual(['ZZZ', 'AAA', 'MMM', 'YYY', 'BBB']);
    // Sanity on the constants the semantics hang off.
    expect(WATCHED_RESERVED_SLOTS).toBeLessThan(MAX_INSTRUMENTS_PER_RUN);
  });
});
