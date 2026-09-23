import { describe, expect, it } from 'vitest';

import { dec } from '@/lib/money';

import {
  groupPaymentsByYear,
  isFxSupported,
  summarizeDividends,
  type DividendSummaryRow,
} from './summary';

/**
 * The one fold serving both scopes: Σ portfolio slices must equal All in
 * Decimal, unrated rows are counted not summed — split into "awaiting" (an
 * allowlisted currency whose rate is still coming) versus "no PLN rate" (a
 * currency NBP never quotes, permanent) — the YTD boundary is the payment
 * date's calendar year, and year groups come newest-first.
 */

type Row = DividendSummaryRow;

function payment(overrides: Partial<Row> = {}): Row {
  return {
    portfolioId: 'port-1',
    exDate: '2026-08-10',
    payDate: '2026-08-13',
    grossAmount: '2.7',
    withheldTax: '0.405',
    fxRateToBase: '3.65',
    currency: 'USD',
    ...overrides,
  };
}

const TODAY = '2026-08-16';

describe('summarizeDividends', () => {
  it('derives net as gross − withheld, times the frozen rate', () => {
    const { all } = summarizeDividends([payment()], TODAY);
    // (2.7 − 0.405) × 3.65 = 8.37675 — exact in Decimal.
    expect(all.netPLN).toBe('8.37675');
    expect(all.count).toBe(1);
    expect(all.awaitingFx).toBe(0);
  });

  it('Σ portfolio slices equals All, in Decimal — scope agreement by construction', () => {
    const rows = [
      payment({ portfolioId: 'A', grossAmount: '10', withheldTax: '1.5', fxRateToBase: '3.6' }),
      payment({ portfolioId: 'A', grossAmount: '3.33', withheldTax: '0.4995', fxRateToBase: '4.1' }),
      payment({ portfolioId: 'B', grossAmount: '7.77', withheldTax: '1.1655', fxRateToBase: '3.9876' }),
    ];
    const { all, byPortfolioId } = summarizeDividends(rows, TODAY);

    const scopeSum = Object.values(byPortfolioId).reduce(
      (sum, scope) => sum.plus(dec(scope.netPLN ?? '0')),
      dec('0'),
    );
    expect(dec(all.netPLN!).equals(scopeSum)).toBe(true);
    expect(Object.keys(byPortfolioId).sort()).toEqual(['A', 'B']);
  });

  it('counts rows awaiting FX instead of summing them — and never fakes a zero total', () => {
    const rows = [
      payment({ fxRateToBase: null }),
      payment({ grossAmount: '4', withheldTax: '0.6', fxRateToBase: '4' }),
    ];
    const { all } = summarizeDividends(rows, TODAY);
    expect(all.netPLN).toBe('13.6');
    expect(all.count).toBe(2);
    expect(all.awaitingFx).toBe(1);

    const onlyAwaiting = summarizeDividends([payment({ fxRateToBase: null })], TODAY);
    expect(onlyAwaiting.all.netPLN).toBeNull();
    expect(onlyAwaiting.all.ytdNetPLN).toBeNull();
    expect(onlyAwaiting.all.awaitingFx).toBe(1);
  });

  it('YTD boundary: Jan 1 payment counts, Dec 31 of the prior year does not', () => {
    const rows = [
      payment({ payDate: '2026-01-01', grossAmount: '1', withheldTax: '0', fxRateToBase: '4' }),
      payment({ payDate: '2025-12-31', grossAmount: '1', withheldTax: '0', fxRateToBase: '4' }),
    ];
    const { all } = summarizeDividends(rows, TODAY);
    expect(all.netPLN).toBe('8');
    expect(all.ytdNetPLN).toBe('4');
  });

  it('a payment with no pay date files under its ex-date', () => {
    const rows = [
      payment({ payDate: null, exDate: '2026-03-05', grossAmount: '1', withheldTax: '0', fxRateToBase: '4' }),
      payment({ payDate: null, exDate: '2025-03-05', grossAmount: '1', withheldTax: '0', fxRateToBase: '4' }),
    ];
    const { all } = summarizeDividends(rows, TODAY);
    expect(all.ytdNetPLN).toBe('4');
  });

  it('empty in, honest nulls out', () => {
    const { all, byPortfolioId } = summarizeDividends([], TODAY);
    expect(all).toEqual({
      netPLN: null,
      ytdNetPLN: null,
      count: 0,
      awaitingFx: 0,
      fxUnsupported: 0,
    });
    expect(byPortfolioId).toEqual({});
  });

  it('a currency with no NBP route counts as "no PLN rate", never "awaiting"', () => {
    // USD null-rate: the next sync can still find it → awaiting. XXX
    // null-rate: outside the allowlist, every sync nulls out forever → the
    // permanent bucket, disclosed separately so "awaiting" is never a lie.
    const rows = [
      payment({ fxRateToBase: null }),
      payment({ currency: 'XXX', fxRateToBase: null }),
      payment({ grossAmount: '4', withheldTax: '0.6', fxRateToBase: '4' }),
    ];
    const { all } = summarizeDividends(rows, TODAY);
    expect(all.awaitingFx).toBe(1);
    expect(all.fxUnsupported).toBe(1);
    expect(all.netPLN).toBe('13.6');

    expect(isFxSupported('USD')).toBe(true);
    expect(isFxSupported('PLN')).toBe(true);
    expect(isFxSupported('XXX')).toBe(false);
  });
});

describe('groupPaymentsByYear', () => {
  it('groups by payment-date year, newest year first, rows newest first within', () => {
    const groups = groupPaymentsByYear([
      payment({ payDate: '2025-05-15' }),
      payment({ payDate: '2026-02-13' }),
      payment({ payDate: '2026-08-13' }),
      // No pay date: files under its ex-date's year.
      payment({ payDate: null, exDate: '2024-11-07' }),
    ]);

    expect(groups.map((g) => g.year)).toEqual(['2026', '2025', '2024']);
    expect(groups[0].rows.map((r) => r.payDate)).toEqual(['2026-08-13', '2026-02-13']);
  });

  it('per-year totals: gross/withheld summed per currency, net derived', () => {
    const [group] = groupPaymentsByYear([
      payment({ grossAmount: '2.7', withheldTax: '0.405' }),
      payment({ grossAmount: '1.3', withheldTax: '0.195' }),
      payment({ currency: 'EUR', grossAmount: '5', withheldTax: '0' }),
    ]);

    expect(group.totals).toEqual([
      { currency: 'EUR', gross: '5', withheld: '0', net: '5' },
      { currency: 'USD', gross: '4', withheld: '0.6', net: '3.4' },
    ]);
  });

  it('year PLN net skips (and counts) rows awaiting a rate', () => {
    const [group] = groupPaymentsByYear([
      payment({ grossAmount: '2', withheldTax: '0', fxRateToBase: '4' }),
      payment({ fxRateToBase: null }),
    ]);
    expect(group.netPLN).toBe('8');
    expect(group.awaitingFx).toBe(1);
    expect(group.fxUnsupported).toBe(0);
  });

  it('year groups split no-route currencies out of the awaiting count too', () => {
    const [group] = groupPaymentsByYear([
      payment({ currency: 'XXX', fxRateToBase: null }),
      payment({ fxRateToBase: null }),
    ]);
    expect(group.awaitingFx).toBe(1);
    expect(group.fxUnsupported).toBe(1);
  });
});
