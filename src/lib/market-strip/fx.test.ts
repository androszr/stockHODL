import { describe, expect, it } from 'vitest';

import type { Candle } from '@/lib/market-data/provider';

import {
  composeFxFigures,
  FX_CAPTION,
  FX_PAIR_LABEL,
  FX_TICKER,
  fxBaseClose,
  sliceLastUtcDays,
  utcDateISOAt,
} from './fx';

/**
 * The USD/PLN figures: a UTC-day market measured from bars, not a quote.
 * The cases that make the figure WRONG rather than absent are the ones that
 * matter — the forming daily bar as a base (0,00% lie), and a New York-day
 * cut of a market that has none.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 2026-09-18 (a Friday) 00:00 UTC. */
const FRI = Date.UTC(2026, 8, 18);
const SUN = FRI + 2 * DAY;
const MON = FRI + 3 * DAY;

function candle(t: number, close: string): Candle {
  return { t, open: close, high: close, low: close, close, volume: '0' };
}

function daily(dateMs: number, close: string): Candle {
  return candle(dateMs, close);
}

describe('utcDateISOAt', () => {
  it('cuts the day at 00:00 UTC, not New York midnight', () => {
    // 01:00 UTC on the 18th is still the 17th in New York.
    expect(utcDateISOAt(FRI + HOUR)).toBe('2026-09-18');
    expect(utcDateISOAt(FRI - HOUR)).toBe('2026-09-17');
  });
});

describe('sliceLastUtcDays', () => {
  it('keeps only the trailing UTC day across the Friday-close / Sunday-reopen gap', () => {
    const points = [
      { t: FRI + 10 * HOUR },
      { t: FRI + 21 * HOUR },
      // Sunday 22:00 UTC — the reopen.
      { t: SUN + 22 * HOUR },
      { t: SUN + 23 * HOUR },
    ];

    const sliced = sliceLastUtcDays(points, 1);

    expect(sliced.map((p) => p.t)).toEqual([SUN + 22 * HOUR, SUN + 23 * HOUR]);
  });

  it('keeps N distinct UTC days, preserving order', () => {
    const points = [
      { t: FRI },
      { t: FRI + HOUR },
      { t: SUN + 22 * HOUR },
      { t: MON + HOUR },
    ];

    expect(sliceLastUtcDays(points, 2).map((p) => p.t)).toEqual([SUN + 22 * HOUR, MON + HOUR]);
    expect(sliceLastUtcDays(points, 5)).toHaveLength(4);
  });

  it('answers nothing for zero days or no points', () => {
    expect(sliceLastUtcDays([{ t: FRI }], 0)).toEqual([]);
    expect(sliceLastUtcDays([], 1)).toEqual([]);
  });
});

describe('fxBaseClose', () => {
  it('picks the last daily bar strictly before the tip UTC date, skipping the forming bar', () => {
    const dailies = [daily(FRI - DAY, '3.70'), daily(FRI, '3.75'), daily(MON, '3.80')];

    // Tip is Monday 15:00 UTC; Monday's own daily bar is still forming.
    expect(fxBaseClose(dailies, MON + 15 * HOUR)).toBe('3.75');
  });

  it('answers null when no daily bar predates the tip', () => {
    expect(fxBaseClose([daily(MON, '3.80')], MON + HOUR)).toBeNull();
    expect(fxBaseClose([], MON + HOUR)).toBeNull();
  });

  it('does not depend on input order', () => {
    const dailies = [daily(FRI, '3.75'), daily(FRI - DAY, '3.70')];
    expect(fxBaseClose(dailies, SUN + 23 * HOUR)).toBe('3.75');
  });
});

describe('composeFxFigures', () => {
  const dailies = [daily(FRI - DAY, '3.7000'), daily(FRI, '3.7500'), daily(MON, '3.7950')];
  const minutes = [
    candle(SUN + 22 * HOUR, '3.7600'),
    candle(MON + 9 * HOUR, '3.7900'),
    candle(MON + 15 * HOUR, '3.7955'),
  ];

  it('formats the tip to four decimals in pl-PL', () => {
    const figures = composeFxFigures(dailies, minutes);

    expect(figures.last).toBe('3,7955');
  });

  it('measures the day against the prior UTC day, not the forming daily bar', () => {
    const figures = composeFxFigures(dailies, minutes);

    // (3.7955 − 3.75) / 3.75 = +1,21%; against the forming Monday bar it
    // would have been a near-zero lie.
    expect(figures.dayPct?.text).toBe('+1,21%');
    expect(figures.dayPct?.direction).toBe('gain');
  });

  it('signs a falling rate and calls it a loss', () => {
    const falling = [candle(MON + 15 * HOUR, '3.7000')];
    const figures = composeFxFigures(dailies, falling);

    expect(figures.dayPct?.text.startsWith('-')).toBe(true);
    expect(figures.dayPct?.direction).toBe('loss');
  });

  it('the spark is the tip UTC day only, oldest first', () => {
    const figures = composeFxFigures(dailies, minutes);

    expect(figures.spark.map((p) => p.t)).toEqual([MON + 9 * HOUR, MON + 15 * HOUR]);
    expect(figures.spark.map((p) => p.v)).toEqual(['3.7900', '3.7955']);
  });

  it('a Sunday-evening stub measures against Friday close', () => {
    const stub = [candle(SUN + 22 * HOUR, '3.7600'), candle(SUN + 23 * HOUR, '3.7650')];
    const figures = composeFxFigures([daily(FRI - DAY, '3.70'), daily(FRI, '3.75')], stub);

    expect(figures.last).toBe('3,7650');
    expect(figures.dayPct?.text).toBe('+0,40%');
    expect(figures.spark).toHaveLength(2);
  });

  it('is all-null on empty intraday bars — there is no tip to measure', () => {
    const figures = composeFxFigures(dailies, []);

    expect(figures).toEqual({ last: null, dayPct: null, spark: [] });
  });

  it('keeps the rate and the spark but nulls the day move on empty daily bars', () => {
    const figures = composeFxFigures([], minutes);

    expect(figures.last).toBe('3,7955');
    expect(figures.dayPct).toBeNull();
    expect(figures.spark).toHaveLength(2);
  });

  it('takes the newest minute bar as the tip regardless of order', () => {
    const shuffled = [minutes[2], minutes[0], minutes[1]];
    const figures = composeFxFigures(dailies, shuffled);

    expect(figures.last).toBe('3,7955');
  });

  it('never emits a number — every figure is a string or null', () => {
    const figures = composeFxFigures(dailies, minutes);

    expect(typeof figures.last).toBe('string');
    expect(typeof figures.dayPct?.text).toBe('string');
    for (const point of figures.spark) expect(typeof point.v).toBe('string');
  });

  it('names the pair, the caption and the vendor ticker as constants', () => {
    expect(FX_TICKER).toBe('C:USDPLN');
    expect(FX_PAIR_LABEL).toBe('USD/PLN');
    expect(FX_CAPTION).toBe('PLN per 1 USD');
  });
});
