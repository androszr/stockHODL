import { describe, expect, it } from 'vitest';

import type { Candle } from '@/lib/market-data/provider';

import {
  addMonthsIso,
  CHART_RANGES,
  intradayAxisTicks,
  lastSharedSessionDates,
  resolveRange,
  sliceLastSessions,
} from './ranges';

/**
 * Hermetic window math — `today` is always injected, never read from the
 * clock. 2026-08-11 is a Tuesday; 2026-08-08/09 are a weekend.
 */

const CTX = { today: '2026-08-11', anchorDate: '2020-03-15' };

describe('CHART_RANGES', () => {
  it('is exactly the eight ranges, in display order', () => {
    expect(CHART_RANGES).toEqual(['1D', '5D', '1M', '6M', 'YTD', '1Y', '5Y', 'ALL']);
  });
});

describe('addMonthsIso', () => {
  it.each([
    ['2026-08-11', -1, '2026-07-11'],
    ['2026-03-31', -1, '2026-02-28'], // end-of-month clamp
    ['2024-03-31', -1, '2024-02-29'], // leap clamp
    ['2026-01-15', -6, '2025-07-15'], // year boundary
    ['2026-08-11', -60, '2021-08-11'], // 5 years
  ])('%s %+d months → %s', (iso, delta, expected) => {
    expect(addMonthsIso(iso, delta)).toBe(expected);
  });
});

describe('resolveRange — daily windows', () => {
  it('YTD starts on January 1 of the current year', () => {
    expect(resolveRange('YTD', CTX)).toEqual({
      kind: 'daily',
      from: '2026-01-01',
      to: '2026-08-11',
    });
  });

  it('1M / 6M / 1Y / 5Y count back calendar months', () => {
    expect(resolveRange('1M', CTX)).toMatchObject({ from: '2026-07-11' });
    expect(resolveRange('6M', CTX)).toMatchObject({ from: '2026-02-11' });
    expect(resolveRange('1Y', CTX)).toMatchObject({ from: '2025-08-11' });
    expect(resolveRange('5Y', CTX)).toMatchObject({ from: '2021-08-11' });
  });

  it('ALL starts exactly at the first transaction', () => {
    expect(resolveRange('ALL', CTX)).toEqual({
      kind: 'daily',
      from: '2020-03-15',
      to: '2026-08-11',
    });
  });

  it('ALL without any transaction resolves to null — empty state, no provider query', () => {
    for (const range of CHART_RANGES) {
      expect(resolveRange(range, { today: '2026-08-11', anchorDate: null })).toBeNull();
    }
  });

  it('5Y on a portfolio younger than 5 years clamps to the anchor', () => {
    const young = { today: '2026-08-11', anchorDate: '2026-02-01' };
    expect(resolveRange('5Y', young)).toEqual({
      kind: 'daily',
      from: '2026-02-01',
      to: '2026-08-11',
    });
    // 1M is younger than the anchor clamp — unaffected.
    expect(resolveRange('1M', young)).toMatchObject({ from: '2026-07-11' });
  });

  it('an anchor in the future (clock skew) clamps from to today, never inverts', () => {
    const skewed = { today: '2026-08-11', anchorDate: '2026-09-01' };
    expect(resolveRange('ALL', skewed)).toEqual({
      kind: 'daily',
      from: '2026-08-11',
      to: '2026-08-11',
    });
  });
});

describe('resolveRange — intraday windows', () => {
  it('1D is 5-minute bars over a lookback wide enough to survive a weekend', () => {
    const resolved = resolveRange('1D', CTX);
    expect(resolved).toMatchObject({ kind: 'intraday', multiplier: 5, sessions: 1 });
    if (resolved?.kind !== 'intraday') throw new Error('expected intraday');
    expect(resolved.fromMs).toBe(Date.parse('2026-08-05T00:00:00Z'));
    expect(resolved.toMs).toBeGreaterThan(Date.parse('2026-08-11T23:59:59Z'));
  });

  it('5D is 30-minute bars over five sessions', () => {
    expect(resolveRange('5D', CTX)).toMatchObject({
      kind: 'intraday',
      multiplier: 30,
      sessions: 5,
    });
  });

  it('clamps the intraday lookback to the anchor', () => {
    const resolved = resolveRange('5D', { today: '2026-08-11', anchorDate: '2026-08-10' });
    if (resolved?.kind !== 'intraday') throw new Error('expected intraday');
    expect(resolved.fromMs).toBe(Date.parse('2026-08-10T00:00:00Z'));
  });
});

/** A 5-minute bar during the given NY session (UTC hour chosen mid-session). */
function bar(dateISO: string, utcHour: number, close: string): Candle {
  const t = Date.parse(`${dateISO}T${String(utcHour).padStart(2, '0')}:00:00Z`);
  return { t, open: close, high: close, low: close, close, volume: '1' };
}

describe('sliceLastSessions — "the last completed session" from data', () => {
  // Thu 2026-08-06 and Fri 2026-08-07 have bars; the weekend has none.
  const candles = [
    bar('2026-08-06', 15, '100.1'),
    bar('2026-08-06', 16, '100.2'),
    bar('2026-08-07', 15, '101.5'),
    bar('2026-08-07', 16, '101.9'),
  ];

  it('1D on a Saturday charts Friday — the last completed session, not an empty chart', () => {
    expect(sliceLastSessions(candles, 1)).toEqual([candles[2], candles[3]]);
  });

  it('1D over a holiday Monday still charts the newest session in the data', () => {
    // A market holiday produces no bars, so Friday remains the newest date.
    expect(sliceLastSessions(candles, 1).every((c) => c.close.startsWith('101'))).toBe(true);
  });

  it('keeps N distinct sessions when asked for more', () => {
    expect(sliceLastSessions(candles, 5)).toEqual(candles);
  });

  it('handles the empty and zero cases', () => {
    expect(sliceLastSessions([], 1)).toEqual([]);
    expect(sliceLastSessions(candles, 0)).toEqual([]);
  });
});

describe('lastSharedSessionDates — ONE session window for a whole portfolio', () => {
  // The pre-market shape: the active list has printed on day2 already, the
  // quiet one still ends at day1.
  const active = [bar('2026-08-13', 15, '100'), bar('2026-08-14', 9, '110')];
  const quiet = [bar('2026-08-13', 15, '50'), bar('2026-08-13', 16, '51')];

  it('sessions: 1 → the newest date ANY list printed — never each list its own', () => {
    expect(lastSharedSessionDates([active, quiet], 1)).toEqual(['2026-08-14']);
  });

  it('sessions: 2 → the trailing two dates of the union, ascending', () => {
    expect(lastSharedSessionDates([active, quiet], 2)).toEqual(['2026-08-13', '2026-08-14']);
  });

  it('disjoint date sets union correctly', () => {
    const monday = [bar('2026-08-10', 15, '1')];
    const wednesday = [bar('2026-08-12', 15, '2')];
    expect(lastSharedSessionDates([monday, wednesday], 5)).toEqual([
      '2026-08-10',
      '2026-08-12',
    ]);
    expect(lastSharedSessionDates([monday, wednesday], 1)).toEqual(['2026-08-12']);
  });

  it('empty input → [] — no lists, empty lists, or zero sessions', () => {
    expect(lastSharedSessionDates([], 1)).toEqual([]);
    expect(lastSharedSessionDates([[], []], 1)).toEqual([]);
    expect(lastSharedSessionDates([active], 0)).toEqual([]);
  });
});

describe('intradayAxisTicks — the categorical intraday axis', () => {
  const at = (iso: string) => Date.parse(iso);

  it('a multi-session window ticks at each session start, unit "day"', () => {
    // Thu and Fri sessions glued together — the weekend gap has no bars.
    const ts = [
      at('2026-08-06T13:30:00Z'),
      at('2026-08-06T14:00:00Z'),
      at('2026-08-07T13:30:00Z'),
      at('2026-08-07T14:00:00Z'),
      at('2026-08-10T13:30:00Z'),
    ];
    expect(intradayAxisTicks(ts)).toEqual({ tickIndices: [0, 2, 4], unit: 'day' });
  });

  it('a single session ticks at each hour start, unit "hour"', () => {
    // 5-minute bars 13:30–15:05 UTC (09:30–11:05 ET) on one date.
    const ts: number[] = [];
    for (let m = 0; m <= 95; m += 5) {
      ts.push(at('2026-08-11T13:30:00Z') + m * 60_000);
    }
    const axis = intradayAxisTicks(ts);
    expect(axis.unit).toBe('hour');
    // First bar (13:30) plus the 14:00 and 15:00 boundaries.
    expect(axis.tickIndices).toEqual([0, 6, 18]);
  });

  it('handles the empty case', () => {
    expect(intradayAxisTicks([])).toEqual({ tickIndices: [], unit: 'hour' });
  });
});
