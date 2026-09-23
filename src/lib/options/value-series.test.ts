import { describe, expect, it } from 'vitest';

import type { OptionPositionRow } from './options-payload';
import {
  composeOptionsSeries,
  disclosedEstimatedFrom,
  mergeOptionValuations,
  type OptionValuationRow,
} from './value-series';

/**
 * Unit tests for the options value-series math: exact Decimal value/basis,
 * holes staying holes, per-day exclusion in lockstep (value AND basis),
 * activation/expiry windows, and the honest empty payload.
 */

const A = 'O:AAA270115C00100000';
const B = 'O:BBB270115C00050000';

const WINDOW = { fromISO: '2026-08-01', toISO: '2026-08-31' };

function lot(overrides: Partial<OptionPositionRow> = {}): OptionPositionRow {
  return {
    id: 'lot-a',
    ticker: A,
    underlying: 'AAA',
    contractType: 'call',
    strikePrice: '100.00000000',
    expirationDate: '2027-01-15',
    sharesPerContract: '100.00000000',
    quantity: '2.00000000',
    entryPrice: '3.50000000',
    tradeDate: '2026-08-01',
    fees: '2.04000000',
    ...overrides,
  };
}

function close(ticker: string, asOf: string, value: string): OptionValuationRow {
  return { ticker, asOf, price: value };
}

describe('value and basis', () => {
  it('computes exact Decimal value and basis (fees included) per day', () => {
    const payload = composeOptionsSeries([lot()], [close(A, '2026-08-13', '5')], WINDOW);
    expect(payload.points).toHaveLength(1);
    // value = 5 × 2 × 100 = 1000; basis = 3.5 × 2 × 100 + 2.04 = 702.04;
    // r = (1000 − 702.04) / 702.04 × 100 ≈ 42.44%.
    expect(payload.points[0].v).toBe('1000.00000000');
    expect(payload.points[0].r?.startsWith('42.44')).toBe(true);
  });

  it('stays exact where float math would drift', () => {
    // 0.05 × 3 × 100 = 15 exactly; IEEE doubles say 15.000000000000002.
    const payload = composeOptionsSeries(
      [lot({ quantity: '3.00000000', fees: '0.00000000' })],
      [close(A, '2026-08-13', '0.05')],
      WINDOW,
    );
    expect(payload.points[0].v).toBe('15.00000000');
  });

  it('omits r when the basis is zero — percent of nothing stays absent', () => {
    const payload = composeOptionsSeries(
      [lot({ entryPrice: '0.00000000', fees: '0.00000000' })],
      [close(A, '2026-08-13', '5')],
      WINDOW,
    );
    expect(payload.points[0].r).toBeUndefined();
  });

  it('lets two lots of one ticker share one close row', () => {
    const payload = composeOptionsSeries(
      [lot({ id: 'lot-1' }), lot({ id: 'lot-2', quantity: '1.00000000' })],
      [close(A, '2026-08-13', '5')],
      WINDOW,
    );
    // 5 × 2 × 100 + 5 × 1 × 100 = 1500.
    expect(payload.points[0].v).toBe('1500.00000000');
    expect(payload.partialDays).toBe(0);
  });
});

describe('holes and partial days', () => {
  it('emits NO point for a date with no readings — a hole, never interpolation', () => {
    const payload = composeOptionsSeries(
      [lot()],
      [close(A, '2026-08-13', '5'), close(A, '2026-08-17', '6')],
      WINDOW,
    );
    // 08-14 traded nowhere → exactly two points, nothing drawn between.
    expect(payload.points.map((p) => p.v)).toEqual(['1000.00000000', '1200.00000000']);
  });

  it('excludes a lot missing a day from BOTH value and basis, and counts the day partial', () => {
    const lots = [lot({ id: 'lot-a' }), lot({ id: 'lot-b', ticker: B, underlying: 'BBB' })];
    const payload = composeOptionsSeries(
      lots,
      [
        close(A, '2026-08-13', '5'),
        close(B, '2026-08-13', '2'),
        close(A, '2026-08-14', '6'),
        // B did not trade on 08-14.
      ],
      WINDOW,
    );
    expect(payload.points).toHaveLength(2);
    // Day 1: both lots → 1000 + 400 = 1400. Day 2: A only → 1200, and the
    // return derives from A's basis alone (basis excluded in lockstep):
    // (1200 − 702.04) / 702.04 ≈ 70.93% — NOT diluted by B's basis.
    expect(payload.points[0].v).toBe('1400.00000000');
    expect(payload.points[1].v).toBe('1200.00000000');
    expect(payload.points[1].r?.startsWith('70.9')).toBe(true);
    expect(payload.partialDays).toBe(1);
  });
});

describe('requireEveryActiveLot — the book-wide total', () => {
  const lots = [lot({ id: 'lot-a' }), lot({ id: 'lot-b', ticker: B, underlying: 'BBB' })];
  const valuations = [
    close(A, '2026-08-13', '5'),
    close(B, '2026-08-13', '2'),
    close(A, '2026-08-14', '6'),
    // B did not print on 08-14 — the partial day.
  ];

  it('drops a day it cannot price in full instead of plotting a partial sum', () => {
    const payload = composeOptionsSeries(lots, valuations, WINDOW, {
      requireEveryActiveLot: true,
    });
    // Only the fully-priced 08-13 survives; 08-14 is a HOLE, not 1200 (which
    // would understate the book and invent an overnight move the next day).
    expect(payload.points).toHaveLength(1);
    expect(payload.points[0].v).toBe('1400.00000000');
  });

  it('counts a dropped day as partial so the caveat line can name it', () => {
    // The day is missing from the line BECAUSE a quote was missing; a chart
    // showing one of two days must not claim zero missing days.
    const payload = composeOptionsSeries(lots, valuations, WINDOW, {
      requireEveryActiveLot: true,
    });
    expect(payload.partialDays).toBe(1);
  });

  it('names a lot whose only readings landed on dropped days', () => {
    // Every day is partial, so NOTHING is plotted: neither lot got a reading
    // onto the screen, so both are named rather than silently absent.
    const payload = composeOptionsSeries(
      lots,
      [close(A, '2026-08-13', '5'), close(B, '2026-08-14', '2')],
      WINDOW,
      { requireEveryActiveLot: true },
    );
    expect(payload.points).toEqual([]);
    expect(payload.excludedSymbols).toHaveLength(2);
  });

  it('does not name a lot that priced on a day which survived', () => {
    const payload = composeOptionsSeries(lots, valuations, WINDOW, {
      requireEveryActiveLot: true,
    });
    expect(payload.excludedSymbols).toEqual([]);
  });

  it('does not affect a day where every active lot is priced', () => {
    const payload = composeOptionsSeries(
      lots,
      [...valuations, close(B, '2026-08-14', '3')],
      WINDOW,
      { requireEveryActiveLot: true },
    );
    expect(payload.points).toHaveLength(2);
    expect(payload.points[1].v).toBe('1800.00000000');
  });

  it('ignores lots that are not active yet — they cannot hole a day', () => {
    const payload = composeOptionsSeries(
      [lot({ id: 'lot-a' }), lot({ id: 'lot-b', ticker: B, tradeDate: '2026-08-20' })],
      [close(A, '2026-08-13', '5')],
      WINDOW,
      { requireEveryActiveLot: true },
    );
    expect(payload.points).toHaveLength(1);
    expect(payload.points[0].v).toBe('1000.00000000');
  });

  it('leaves the default (single-contract) behaviour untouched', () => {
    const payload = composeOptionsSeries(lots, valuations, WINDOW);
    expect(payload.points).toHaveLength(2);
    expect(payload.partialDays).toBe(1);
  });
});

describe('activation and expiry', () => {
  it('activates a lot only from its trade date', () => {
    const payload = composeOptionsSeries(
      [lot({ tradeDate: '2026-08-14' })],
      [close(A, '2026-08-13', '5'), close(A, '2026-08-14', '6')],
      WINDOW,
    );
    // The 08-13 close predates the lot → no contribution → no point that day.
    expect(payload.points).toHaveLength(1);
    expect(payload.points[0].v).toBe('1200.00000000');
  });

  it('drops a lot from the series after its expiration date', () => {
    const payload = composeOptionsSeries(
      [lot({ expirationDate: '2026-08-13' })],
      [close(A, '2026-08-13', '5'), close(A, '2026-08-14', '6')],
      WINDOW,
    );
    expect(payload.points).toHaveLength(1); // expiry day itself still counts
    expect(payload.points[0].t).toBe(Date.UTC(2026, 7, 13, 12));
  });

  it('names a lot with zero readings in the window in excludedSymbols', () => {
    const lots = [lot(), lot({ id: 'lot-b', ticker: B, underlying: 'BBB', strikePrice: '50' })];
    const payload = composeOptionsSeries(lots, [close(A, '2026-08-13', '5')], WINDOW);
    expect(payload.excludedSymbols).toEqual(['BBB $50C']);
  });
});

describe('window and envelope', () => {
  it('clips closes outside the window', () => {
    const payload = composeOptionsSeries(
      [lot()],
      [close(A, '2026-07-31', '4'), close(A, '2026-08-13', '5'), close(A, '2026-09-01', '7')],
      WINDOW,
    );
    expect(payload.points).toHaveLength(1);
    expect(payload.anchorDate).toBe('2026-08-13');
  });

  it('places every point at UTC noon of its NY date', () => {
    const payload = composeOptionsSeries([lot()], [close(A, '2026-08-13', '5')], WINDOW);
    expect(payload.points[0].t).toBe(Date.UTC(2026, 7, 13, 12));
  });

  it('returns the canonical empty payload when no closes exist', () => {
    const payload = composeOptionsSeries([lot()], [], WINDOW);
    expect(payload.points).toEqual([]);
    expect(payload.anchorDate).toBeNull();
    expect(payload.excludedSymbols).toEqual([]);
  });
});

/**
 * `mergeOptionValuations` — the mark/close precedence of 2026-08-20. The rule
 * it encodes is a product decision with a visible consequence (a step in the
 * line at the seam), so each half of it is pinned here rather than left to the
 * two callers to reproduce.
 */
describe('mergeOptionValuations', () => {
  it('prefers the MARK on a date carrying both', () => {
    const merged = mergeOptionValuations(
      [close(A, '2026-08-17', '9.99')],
      [close(A, '2026-08-17', '12.10')],
    );
    expect(merged.rows).toEqual([{ ticker: A, asOf: '2026-08-17', price: '9.99' }]);
  });

  it('falls back to the traded CLOSE on a date with only a close', () => {
    const merged = mergeOptionValuations([], [close(A, '2026-06-02', '4.20')]);
    expect(merged.rows).toEqual([{ ticker: A, asOf: '2026-06-02', price: '4.20' }]);
    expect(merged.estimatedFrom).toBeNull();
  });

  it('emits NO row for a date with neither source', () => {
    const merged = mergeOptionValuations(
      [close(A, '2026-08-17', '9.99')],
      [close(A, '2026-08-14', '8.00')],
    );
    expect(merged.rows.map((r) => r.asOf)).toEqual(['2026-08-14', '2026-08-17']);
    // Nothing invented for 15 or 16 — the gap survives the merge.
    expect(merged.rows).toHaveLength(2);
  });

  it('leaves a neither-source date as a HOLE end to end (no point)', () => {
    const merged = mergeOptionValuations(
      [close(A, '2026-08-17', '10')],
      [close(A, '2026-08-13', '8')],
    );
    const payload = composeOptionsSeries([lot()], merged.rows, WINDOW);
    // Two points, not four: 14, 15 and 16 are holes and stay holes.
    expect(payload.points).toHaveLength(2);
  });

  it('reports estimatedFrom as the first date a mark was used', () => {
    const merged = mergeOptionValuations(
      [close(A, '2026-08-17', '10'), close(A, '2026-08-18', '11')],
      [close(A, '2026-08-13', '8'), close(A, '2026-08-17', '12')],
    );
    expect(merged.estimatedFrom).toBe('2026-08-17');
  });

  it('reports the EARLIER first-mark date across two tickers', () => {
    const merged = mergeOptionValuations(
      [close(B, '2026-08-15', '3'), close(A, '2026-08-17', '10')],
      [close(A, '2026-08-13', '8')],
    );
    expect(merged.estimatedFrom).toBe('2026-08-15');
  });

  it('keeps both tickers on a shared date, each priced by its own source', () => {
    const merged = mergeOptionValuations(
      [close(A, '2026-08-17', '10')],
      [close(A, '2026-08-17', '12'), close(B, '2026-08-17', '3')],
    );
    expect(merged.rows).toEqual([
      { ticker: A, asOf: '2026-08-17', price: '10' },
      { ticker: B, asOf: '2026-08-17', price: '3' },
    ]);
  });

  it('returns nothing at all when both sources are empty', () => {
    const merged = mergeOptionValuations([], []);
    expect(merged.rows).toEqual([]);
    expect(merged.estimatedFrom).toBeNull();
  });

  it('sorts ascending by date, so the composer sees the order it expects', () => {
    const merged = mergeOptionValuations(
      [close(A, '2026-08-18', '11')],
      [close(A, '2026-08-03', '5'), close(A, '2026-08-11', '6')],
    );
    expect(merged.rows.map((r) => r.asOf)).toEqual(['2026-08-03', '2026-08-11', '2026-08-18']);
  });

  it('passes prices through as STRINGS — no arithmetic, no float', () => {
    const merged = mergeOptionValuations([], [close(A, '2026-08-03', '0.15600000')]);
    expect(merged.rows[0].price).toBe('0.15600000');
  });
});

/**
 * `disclosedEstimatedFrom` — the caption is a claim about points to the LEFT
 * of the seam, so it may only ride when such points exist (2026-08-20 fix).
 */
describe('disclosedEstimatedFrom', () => {
  const payload = (dates: readonly string[]) =>
    composeOptionsSeries(
      [lot()],
      dates.map((d) => close(A, d, '5')),
      WINDOW,
    ).points;

  it('discloses the seam when traded-close points precede it', () => {
    expect(disclosedEstimatedFrom('2026-08-17', payload(['2026-08-13', '2026-08-17']))).toBe(
      '2026-08-17',
    );
  });

  it('stays absent when the seam IS the first plotted point', () => {
    expect(disclosedEstimatedFrom('2026-08-13', payload(['2026-08-13', '2026-08-17']))).toBeNull();
  });

  it('stays absent when the seam is later than every plotted point', () => {
    expect(disclosedEstimatedFrom('2026-08-20', payload(['2026-08-13']))).toBeNull();
  });

  it('stays absent with no marks at all, and on an empty line', () => {
    expect(disclosedEstimatedFrom(null, payload(['2026-08-13']))).toBeNull();
    expect(disclosedEstimatedFrom('2026-08-17', [])).toBeNull();
  });
});
