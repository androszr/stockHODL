import { describe, expect, it } from 'vitest';

import { dec } from '@/lib/money';

import { aggregateOptionLots } from './aggregate-lots';
import type { OptionPositionRow } from './options-payload';

/**
 * The money edge cases that make aggregation WRONG rather than merely absent:
 * a plain mean instead of a quantity-weighted average, a pre-rounded average,
 * a division by a zero total quantity, and a single lot quietly re-derived
 * through `.times(q).dividedBy(q)`.
 */

const TICKER = 'O:AAPL260904C00220000';

function row(overrides: Partial<OptionPositionRow> = {}): OptionPositionRow {
  return {
    id: 'lot-1',
    ticker: TICKER,
    underlying: 'AAPL',
    contractType: 'call',
    strikePrice: '220.00000000',
    expirationDate: '2026-09-04',
    sharesPerContract: '100.00000000',
    quantity: '2.00000000',
    entryPrice: '3.50000000',
    tradeDate: '2026-08-10',
    fees: '0.00000000',
    ...overrides,
  };
}

describe('merging lots of one contract', () => {
  it('sums the quantity and takes the QUANTITY-WEIGHTED average entry', () => {
    // 1 @ 5.00 + 2 @ 5.01 → (5 + 10.02) / 3 = 5.006666… — NOT the plain mean
    // 5.005, which is what a naive average would give. The two differ
    // whenever the lot sizes do, and break-even derives from this figure.
    const out = aggregateOptionLots([
      row({ id: 'a', quantity: '1', entryPrice: '5.00', fees: '1.02' }),
      row({ id: 'b', quantity: '2', entryPrice: '5.01', fees: '2.04' }),
    ]);
    expect(out).toHaveLength(1);
    expect(dec(out[0].quantity).equals(dec('3'))).toBe(true);
    expect(dec(out[0].entryPrice).equals(dec('5.005'))).toBe(false);
    expect(out[0].entryPrice.startsWith('5.00666666')).toBe(true);
    // Exactly Σ(entry×qty)/Σ(qty), to the configured precision.
    expect(
      dec(out[0].entryPrice).equals(dec('15.02').dividedBy(dec('3'))),
    ).toBe(true);
    expect(dec(out[0].fees).equals(dec('3.06'))).toBe(true);
  });

  it('emits the average at FULL precision — never pre-rounded to 8 dp', () => {
    const out = aggregateOptionLots([
      row({ id: 'a', quantity: '1', entryPrice: '5.00' }),
      row({ id: 'b', quantity: '2', entryPrice: '5.01' }),
    ]);
    // `toNumeric`'s toFixed(8) would give '5.00666667'; the string here must
    // carry more digits than that, because P/L and break-even derive from it.
    expect(out[0].entryPrice.length).toBeGreaterThan('5.00666667'.length);
    expect(out[0].entryPrice).not.toBe('5.00666667');
  });

  it('takes the EARLIEST trade date and orders lots oldest first', () => {
    const out = aggregateOptionLots([
      row({ id: 'newer', tradeDate: '2026-08-12' }),
      row({ id: 'older', tradeDate: '2026-08-03' }),
    ]);
    expect(out[0].tradeDate).toBe('2026-08-03');
    expect(out[0].lots.map((l) => l.id)).toEqual(['older', 'newer']);
  });

  it('breaks a same-day lot tie by row id, so the menu order is total', () => {
    const out = aggregateOptionLots([
      row({ id: 'z', tradeDate: '2026-08-10' }),
      row({ id: 'a', tradeDate: '2026-08-10' }),
    ]);
    expect(out[0].lots.map((l) => l.id)).toEqual(['a', 'z']);
  });

  it('carries EVERY member lot, so no purchase becomes unreachable', () => {
    const out = aggregateOptionLots([
      row({ id: 'a' }),
      row({ id: 'b' }),
      row({ id: 'c' }),
    ]);
    expect(out[0].lots).toHaveLength(3);
    expect(out[0].lots.map((l) => l.id).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('a single lot is passed through VERBATIM', () => {
  it('returns the stored strings, not a re-derived round trip', () => {
    const only = row({ quantity: '2.00000000', entryPrice: '3.50000000', fees: '2.04000000' });
    const out = aggregateOptionLots([only]);
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe('2.00000000');
    expect(out[0].entryPrice).toBe('3.50000000');
    expect(out[0].fees).toBe('2.04000000');
    expect(out[0].tradeDate).toBe('2026-08-10');
    expect(out[0].key).toBe(TICKER);
    expect(out[0].lots).toEqual([only]);
  });
});

describe('what never merges', () => {
  it('keeps different strikes, expiries and underlyings apart', () => {
    const out = aggregateOptionLots([
      row({ id: 'a', ticker: 'O:AAPL260904C00220000', strikePrice: '220' }),
      row({ id: 'b', ticker: 'O:AAPL260904C00220500', strikePrice: '220.5' }),
      row({ id: 'c', ticker: 'O:AAPL261002C00220000', expirationDate: '2026-10-02' }),
      row({ id: 'd', ticker: 'O:MSFT260904C00220000', underlying: 'MSFT' }),
    ]);
    expect(out).toHaveLength(4);
    expect(out.map((a) => a.lots.length)).toEqual([1, 1, 1, 1]);
  });

  it('refuses to merge a group whose total quantity is zero', () => {
    // Defence in depth: validation forbids a non-positive quantity, but a
    // zero Σ would put Infinity/NaN into a money string if it ever reached
    // the division.
    const out = aggregateOptionLots([
      row({ id: 'a', quantity: '0' }),
      row({ id: 'b', quantity: '0' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.key)).toEqual([`${TICKER}#a`, `${TICKER}#b`]);
    for (const agg of out) {
      expect(agg.quantity).toBe('0');
      expect(agg.entryPrice).toBe('3.50000000');
      const strings = [agg.quantity, agg.entryPrice, agg.fees];
      for (const s of strings) {
        expect(s).not.toContain('NaN');
        expect(s).not.toContain('Infinity');
        expect(dec(s).isFinite()).toBe(true);
      }
    }
  });

  it('refuses to merge members disagreeing on sharesPerContract', () => {
    const out = aggregateOptionLots([
      row({ id: 'a', sharesPerContract: '100.00000000' }),
      row({ id: 'b', sharesPerContract: '10.00000000' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.key)).toEqual([`${TICKER}#a`, `${TICKER}#b`]);
    expect(out[0].sharesPerContract).toBe('100.00000000');
    expect(out[1].sharesPerContract).toBe('10.00000000');
  });
});

describe('identity and determinism', () => {
  it('gives every card a unique key, degenerate groups included', () => {
    const out = aggregateOptionLots([
      row({ id: 'a' }),
      row({ id: 'b' }),
      row({ id: 'c', ticker: 'O:MSFT260904C00220000', underlying: 'MSFT' }),
      row({ id: 'd', ticker: 'O:NVDA260904C00220000', underlying: 'NVDA', quantity: '0' }),
      row({ id: 'e', ticker: 'O:NVDA260904C00220000', underlying: 'NVDA', quantity: '0' }),
    ]);
    const keys = out.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is deterministic and first-appearance ordered', () => {
    const rows = [
      row({ id: 'a', ticker: 'O:ZZZ260904C00220000', underlying: 'ZZZ' }),
      row({ id: 'b' }),
      row({ id: 'c' }),
    ];
    const first = aggregateOptionLots(rows).map((a) => a.key);
    const second = aggregateOptionLots(rows).map((a) => a.key);
    expect(first).toEqual(second);
    // The group appears where its FIRST member did — the loader's createdAt
    // ordering, preserved.
    expect(first).toEqual(['O:ZZZ260904C00220000', TICKER]);
  });

  it('does not mutate its input', () => {
    const rows = [row({ id: 'b', tradeDate: '2026-08-12' }), row({ id: 'a', tradeDate: '2026-08-03' })];
    const snapshot = rows.map((r) => r.id);
    aggregateOptionLots(rows);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });
});

describe('every borrowed field is guarded, not just the multiplier', () => {
  // The OCC ticker encodes underlying, type, strike and expiry, so members
  // SHOULD agree — but nothing in the write path enforces it: the add schema
  // validates each field independently of the ticker. Merging on a mismatch
  // would print one member's strike, derive BREAK-EVEN from it for both lots,
  // and let one member's expiry decide whether the card hides behind the
  // expired toggle (bug audit, 2026-08-15).
  const cases: [string, Partial<OptionPositionRow>][] = [
    ['strike', { strikePrice: '230.00000000' }],
    ['expiry', { expirationDate: '2026-09-11' }],
    ['type', { contractType: 'put' }],
    ['underlying', { underlying: 'MSFT' }],
    ['shares per contract', { sharesPerContract: '10.00000000' }],
  ];

  for (const [what, override] of cases) {
    it(`refuses to merge lots disagreeing on ${what}`, () => {
      const out = aggregateOptionLots([
        row({ id: 'lot-a' }),
        row({ id: 'lot-b', ...override }),
      ]);
      // Two entries, each still holding its OWN stored figures.
      expect(out).toHaveLength(2);
      expect(out.map((a) => a.key).sort()).toEqual(
        [`${TICKER}#lot-a`, `${TICKER}#lot-b`].sort(),
      );
      for (const agg of out) {
        expect(agg.lots).toHaveLength(1);
        expect(agg.entryPrice).toBe(agg.lots[0].entryPrice);
        expect(agg.quantity).toBe(agg.lots[0].quantity);
      }
    });
  }

  it('still merges when a strike differs only in trailing zeros', () => {
    // Decimal equality, not string equality: '220' and '220.00000000' are one
    // strike, and treating them as a mismatch would refuse a legitimate merge.
    const out = aggregateOptionLots([
      row({ id: 'lot-a' }),
      row({ id: 'lot-b', strikePrice: '220' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].lots).toHaveLength(2);
  });
});
