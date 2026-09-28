import { describe, expect, it } from 'vitest';

import { dec } from '@/lib/money';

import {
  computeExtendedSummary,
  type ExtendedPosition,
  type ExtendedQuote,
} from './extended-summary';

/**
 * The arithmetic contract of the book-wide extended-hours figure
 * (plans/2026-09-28-watchlist-grid-extended-hours.md). Every rule the
 * Dashboard box and the widgets' "Pre"/"AH" label rely on is pinned here.
 */

function pos(symbol: string, quantity: string, currency = 'USD'): ExtendedPosition {
  return { symbol, currency, quantity: dec(quantity) };
}

function q(overrides: Partial<ExtendedQuote> = {}): ExtendedQuote {
  return {
    currency: 'USD',
    extendedChangeAmt: '1',
    extendedChangePct: '1',
    extendedKind: 'early',
    extendedLive: true,
    ...overrides,
  };
}

const USD = new Map([['USD', '4.00']]);

describe('computeExtendedSummary', () => {
  it('sums quantity × amount × rate on Decimal across two live early quotes', () => {
    const result = computeExtendedSummary(
      [pos('AAPL', '10'), pos('MSFT', '3')],
      new Map([
        ['AAPL', q({ extendedChangeAmt: '0.1' })],
        ['MSFT', q({ extendedChangeAmt: '0.2' })],
      ]),
      USD,
      dec('10000'),
    );
    // 10 × 0.1 × 4 + 3 × 0.2 × 4 = 4 + 2.4 = 6.4 — exact, no float drift.
    expect(result?.movePLN.eq(dec('6.4'))).toBe(true);
    expect(result?.valueAtExtendedPLN.eq(dec('10006.4'))).toBe(true);
    expect(result?.movePct?.eq(dec('0.064'))).toBe(true);
    expect(result?.pricedCount).toBe(2);
    expect(result?.holdingsCount).toBe(2);
  });

  it('a PLN position uses rate 1 without an FX entry', () => {
    const result = computeExtendedSummary(
      [pos('CDR', '2', 'PLN')],
      new Map([['CDR', q({ currency: 'PLN', extendedChangeAmt: '-5' })]]),
      new Map(),
      dec('1000'),
    );
    expect(result?.movePLN.eq(dec('-10'))).toBe(true);
  });

  it('a live quote without a rate is excluded from the move and pricedCount, but counted in holdingsCount', () => {
    const result = computeExtendedSummary(
      [pos('AAPL', '10'), pos('SAP', '4', 'EUR')],
      new Map([
        ['AAPL', q({ extendedChangeAmt: '1' })],
        ['SAP', q({ currency: 'EUR', extendedChangeAmt: '100' })],
      ]),
      USD,
      dec('5000'),
    );
    expect(result?.movePLN.eq(dec('40'))).toBe(true);
    expect(result?.pricedCount).toBe(1);
    expect(result?.holdingsCount).toBe(2);
  });

  it('extendedLive false contributes nothing — a stale reading never aggregates', () => {
    const result = computeExtendedSummary(
      [pos('AAPL', '10'), pos('MSFT', '1')],
      new Map([
        ['AAPL', q({ extendedChangeAmt: '1' })],
        ['MSFT', q({ extendedKind: 'late', extendedLive: false, extendedChangeAmt: '99' })],
      ]),
      USD,
      dec('5000'),
    );
    expect(result?.movePLN.eq(dec('40'))).toBe(true);
    expect(result?.pricedCount).toBe(1);
  });

  it('all readings not live ⇒ null (the box vanishes at 09:30 and 20:00)', () => {
    expect(
      computeExtendedSummary(
        [pos('AAPL', '10')],
        new Map([['AAPL', q({ extendedKind: 'late', extendedLive: false })]]),
        USD,
        dec('5000'),
      ),
    ).toBeNull();
  });

  it('a quote with no extended amount, or no kind, does not contribute', () => {
    expect(
      computeExtendedSummary(
        [pos('AAPL', '10'), pos('MSFT', '1')],
        new Map([
          ['AAPL', q({ extendedChangeAmt: null })],
          ['MSFT', q({ extendedChangeAmt: undefined })],
        ]),
        USD,
        dec('5000'),
      ),
    ).toBeNull();
    expect(
      computeExtendedSummary(
        [pos('AAPL', '10')],
        new Map([['AAPL', q({ extendedKind: null })]]),
        USD,
        dec('5000'),
      ),
    ).toBeNull();
  });

  it('a null regular total ⇒ null — there is no base to state a value from', () => {
    expect(
      computeExtendedSummary([pos('AAPL', '10')], new Map([['AAPL', q()]]), USD, null),
    ).toBeNull();
  });

  it('a zero regular total ⇒ the move is stated with a null percent, never 0,00%', () => {
    const result = computeExtendedSummary(
      [pos('AAPL', '10')],
      new Map([['AAPL', q()]]),
      USD,
      dec('0'),
    );
    expect(result).not.toBeNull();
    expect(result?.movePct).toBeNull();
    expect(result?.movePLN.eq(dec('40'))).toBe(true);
  });

  it('movers: ordered by |impact| descending, ties by symbol, capped at three', () => {
    const result = computeExtendedSummary(
      [pos('AAA', '1'), pos('ZZZ', '1'), pos('BIG', '1'), pos('NEG', '1'), pos('SML', '1')],
      new Map([
        ['AAA', q({ extendedChangeAmt: '2' })],
        ['ZZZ', q({ extendedChangeAmt: '2' })],
        ['BIG', q({ extendedChangeAmt: '1' })],
        ['NEG', q({ extendedChangeAmt: '-5', extendedChangePct: '-3' })],
        ['SML', q({ extendedChangeAmt: '0.5' })],
      ]),
      USD,
      dec('10000'),
    );
    expect(result?.movers.map((m) => m.symbol)).toEqual(['NEG', 'AAA', 'ZZZ']);
    expect(result?.movers[0].amtDec.isNegative()).toBe(true);
    expect(result?.movers[0].pctDec?.eq(dec('-3'))).toBe(true);
    expect(result?.pricedCount).toBe(5);
  });

  it('kind comes from the first contributing quote', () => {
    const result = computeExtendedSummary(
      [pos('OFF', '1'), pos('LATE', '1')],
      new Map([
        ['OFF', q({ extendedKind: 'early', extendedLive: false })],
        ['LATE', q({ extendedKind: 'late' })],
      ]),
      USD,
      dec('1000'),
    );
    expect(result?.kind).toBe('late');
  });

  it('a wrong-currency quote is ignored — never multiplied by the wrong rate', () => {
    expect(
      computeExtendedSummary(
        [pos('CDR', '10', 'PLN')],
        new Map([['CDR', q({ currency: 'USD' })]]),
        USD,
        dec('1000'),
      ),
    ).toBeNull();
  });

  it('zero-quantity rows are neither priced nor counted as holdings', () => {
    const result = computeExtendedSummary(
      [pos('AAPL', '10'), pos('GONE', '0')],
      new Map([
        ['AAPL', q()],
        ['GONE', q({ extendedChangeAmt: '50' })],
      ]),
      USD,
      dec('1000'),
    );
    expect(result?.holdingsCount).toBe(1);
    expect(result?.pricedCount).toBe(1);
    expect(result?.movePLN.eq(dec('40'))).toBe(true);
  });
});
