import { describe, expect, it } from 'vitest';

import type { Candle } from '@/lib/market-data/provider';
import { dec } from '@/lib/money';

import { crossedTarget } from './target-cross';

/** A 5-minute bar. Prices as decimal strings, exactly as the provider emits. */
function bar(t: number, low: string, high: string): Candle {
  return { t, open: low, high, low, close: high, volume: '1000' };
}

const T0 = 1_757_000_000_000;
const MIN5 = 5 * 60 * 1000;

describe('crossedTarget', () => {
  it("fires an 'up' target when a qualifying bar's high reaches past it", () => {
    const candles = [bar(T0, '180.00', '182.00'), bar(T0 + MIN5, '181.00', '190.50')];
    expect(crossedTarget(candles, dec('190'), 'up', T0)).toBe(true);
  });

  it("fires a 'down' target when a qualifying bar's low reaches under it", () => {
    const candles = [bar(T0, '180.00', '182.00'), bar(T0 + MIN5, '174.90', '181.00')];
    expect(crossedTarget(candles, dec('175'), 'down', T0)).toBe(true);
  });

  it('an exact touch fires — "rises to" includes equality, both directions', () => {
    const touch = [bar(T0, '175.00', '190.00')];
    expect(crossedTarget(touch, dec('190'), 'up', T0)).toBe(true);
    expect(crossedTarget(touch, dec('175'), 'down', T0)).toBe(true);
  });

  it('ignores bars from before the target existed — the stale-spike case', () => {
    // A morning spike to 195, then the target is set at 190 while the stock
    // trades at 185. Without the cutoff this would "hit" immediately.
    const createdAt = T0 + 2 * MIN5;
    const candles = [
      bar(T0, '184.00', '195.00'),
      bar(T0 + MIN5, '184.00', '186.00'),
      bar(createdAt, '184.50', '185.50'),
    ];
    expect(crossedTarget(candles, dec('190'), 'up', createdAt)).toBe(false);
  });

  it('skips the partial bar spanning the creation instant', () => {
    // The bar STARTED before the target existed; its spike may predate the
    // target too, and the bias is toward not firing on ambiguous data.
    const createdAt = T0 + MIN5 / 2;
    const candles = [bar(T0, '184.00', '195.00')];
    expect(crossedTarget(candles, dec('190'), 'up', createdAt)).toBe(false);
  });

  it('an empty candle list never fires', () => {
    expect(crossedTarget([], dec('190'), 'up', T0)).toBe(false);
    expect(crossedTarget([], dec('175'), 'down', T0)).toBe(false);
  });

  it('no crossing means no fire, both directions', () => {
    const candles = [bar(T0, '180.00', '182.00'), bar(T0 + MIN5, '181.00', '183.00')];
    expect(crossedTarget(candles, dec('190'), 'up', T0)).toBe(false);
    expect(crossedTarget(candles, dec('175'), 'down', T0)).toBe(false);
  });

  it('a bar that gapped past the line still fires', () => {
    // The stock opened BEYOND the target — no bar ever printed the target
    // price itself, and the line must fire anyway.
    const gappedUp = [bar(T0, '195.00', '198.00')];
    expect(crossedTarget(gappedUp, dec('190'), 'up', T0)).toBe(true);

    const gappedDown = [bar(T0, '160.00', '165.00')];
    expect(crossedTarget(gappedDown, dec('175'), 'down', T0)).toBe(true);
  });

  it('comparisons are decimal, not float — 0.1 + 0.2 style highs still compare exactly', () => {
    const candles = [bar(T0, '0.29999999', '0.30000000')];
    expect(crossedTarget(candles, dec('0.3'), 'up', T0)).toBe(true);
    expect(crossedTarget(candles, dec('0.30000001'), 'up', T0)).toBe(false);
  });
});
