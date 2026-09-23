import { describe, expect, it } from 'vitest';

import { dec } from '@/lib/money';

import { computeWindowMoves } from './price-move';

const closes = (values: readonly number[]) => values.map((v) => dec(v));

describe('computeWindowMoves', () => {
  it('no bars → both moves null, never a fabricated 0%', () => {
    expect(computeWindowMoves([])).toEqual({ upPct: null, downPct: null });
  });

  it('a single bar → both moves null (no window to measure)', () => {
    expect(computeWindowMoves(closes([100]))).toEqual({ upPct: null, downPct: null });
  });

  it('a flat window → both moves are exactly 0%', () => {
    const moves = computeWindowMoves(closes([100, 100, 100]));
    expect(moves.upPct?.toNumber()).toBe(0);
    expect(moves.downPct?.toNumber()).toBe(0);
  });

  it('a 6% rally from the window low to the latest close', () => {
    const moves = computeWindowMoves(closes([100, 95, 98, 106]));
    expect(moves.upPct?.toFixed(2)).toBe('11.58'); // (106 - 95) / 95
    expect(moves.downPct?.toNumber()).toBe(0); // latest close IS the window high
  });

  it('a 6% drop from the window high to the latest close', () => {
    const moves = computeWindowMoves(closes([100, 110, 105, 103]));
    expect(moves.downPct?.toFixed(2)).toBe('-6.36'); // (103 - 110) / 110
    expect(moves.upPct?.toFixed(2)).toBe('3.00'); // (103 - 100) / 100 — the window low, not the latest low point
  });

  it('exactly a 5% move is reported, not rounded away', () => {
    const moves = computeWindowMoves(closes([100, 105]));
    expect(moves.upPct?.toNumber()).toBe(5);
  });

  it('a window whose low is zero reports null rather than dividing by zero', () => {
    const moves = computeWindowMoves(closes([0, 10]));
    expect(moves.upPct).toBeNull();
  });

  it('order matters: only the LATEST close is "now" — an earlier spike does not count', () => {
    // The window spiked to 120 mid-way but settled back near where it started.
    const moves = computeWindowMoves(closes([100, 120, 101]));
    expect(moves.upPct?.toFixed(2)).toBe('1.00'); // (101 - 100) / 100
    expect(moves.downPct?.toFixed(2)).toBe('-15.83'); // (101 - 120) / 120
  });
});
