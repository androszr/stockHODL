import { describe, expect, it, vi } from 'vitest';

// The module under test is `server-only`; the pure half it exports is not.
vi.mock('server-only', () => ({}));

import { toTrendDays } from '@/lib/trend/day-trend';
import { OPTION_TREND_SCALE } from '@/lib/trend/trend-scale';

import { tagValuations } from './recent-valuations';
import type { OptionValuationRow } from './value-series';

/**
 * The source tag, which is the only decision this module adds on top of
 * `mergeOptionValuations`. The precedence itself is that module's contract and
 * is tested there — what is pinned here is that the tag agrees with whichever
 * row actually won, because the grader refuses a pair on it.
 */

const row = (ticker: string, asOf: string, price: string): OptionValuationRow => ({
  ticker,
  asOf,
  price,
});

const TICKER = 'O:ACME270319C00260000';

describe('tagValuations', () => {
  it('tags a date a mark won as a mark, and one only a close covers as a close', () => {
    const points = tagValuations(
      [row(TICKER, '2026-08-21', '13.5')],
      [row(TICKER, '2026-08-20', '12.1'), row(TICKER, '2026-08-21', '13.07')],
    ).get(TICKER);

    expect(points).toEqual([
      { asOf: '2026-08-20', close: '12.1', source: 'close' },
      // The mark won the shared date — and the close's 13.07 is gone, not
      // averaged in.
      { asOf: '2026-08-21', close: '13.5', source: 'mark' },
    ]);
  });

  it('keeps contracts apart even when they share a date', () => {
    const other = 'O:ZORA270319C00095000';
    const byTicker = tagValuations(
      [row(TICKER, '2026-08-21', '13.5')],
      [row(other, '2026-08-21', '3.9')],
    );

    expect(byTicker.get(TICKER)).toEqual([
      { asOf: '2026-08-21', close: '13.5', source: 'mark' },
    ]);
    expect(byTicker.get(other)).toEqual([{ asOf: '2026-08-21', close: '3.9', source: 'close' }]);
  });

  it('leaves a contract with nothing recorded ABSENT, never present and empty', () => {
    // Absent and present-but-empty render identically and one of them costs a
    // row on every tile of a grid.
    expect(tagValuations([], []).has(TICKER)).toBe(false);
    expect(tagValuations([], []).size).toBe(0);
  });

  it('feeds the grader a seam it then refuses to grade', () => {
    // The end-to-end point of the tag. 2026-08-20 is a traded close, 08-21 is
    // a mark; the jump between them is partly a change of instrument, so the
    // session is a hole rather than a +11% bar.
    const points = tagValuations(
      [row(TICKER, '2026-08-21', '13.5')],
      [row(TICKER, '2026-08-20', '12.1')],
    ).get(TICKER);

    expect(
      toTrendDays(['2026-08-20', '2026-08-21'], points ?? [], OPTION_TREND_SCALE),
    ).toEqual([null]);
  });

  it('grades a run of marks normally', () => {
    const points = tagValuations(
      [row(TICKER, '2026-08-20', '12'), row(TICKER, '2026-08-21', '13.2')],
      [],
    ).get(TICKER);

    expect(
      toTrendDays(['2026-08-20', '2026-08-21'], points ?? [], OPTION_TREND_SCALE)[0],
    ).toMatchObject({ direction: 'gain', level: 2 });
  });
});
