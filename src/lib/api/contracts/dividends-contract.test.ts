import { describe, expect, it } from 'vitest';

import type { DividendPaymentRow } from '@/lib/dividends/store';
import { groupPaymentsByYear, summarizeDividends } from '@/lib/dividends/summary';
import { dec, toNumeric } from '@/lib/money';

import { dividendsResponseSchema } from './dividends';

/**
 * THE anti-drift test for dividends — the `options-contract.test.ts`
 * arrangement, for the same reason: the Swift structs are generated from the
 * SCHEMA, while the payload is built from `DividendPaymentRow` and the two
 * pure folds. A column added to the store but not the schema would ship a
 * field the phone silently cannot see; one dropped would leave it decoding
 * something that no longer arrives.
 *
 * Running the real folds through the real schema closes both directions.
 */

function row(overrides: Partial<DividendPaymentRow> = {}): DividendPaymentRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    portfolioId: '22222222-2222-4222-8222-222222222222',
    portfolioName: 'Main',
    instrumentId: '33333333-3333-4333-8333-333333333333',
    symbol: 'AAPL',
    displayName: 'Apple Inc.',
    vendorEventId: 'evt-1',
    exDate: '2026-02-06',
    payDate: '2026-02-13',
    quantity: '100.00000000',
    amountPerShare: '0.25000000',
    grossAmount: '25.00000000',
    withheldTax: '3.75000000',
    currency: 'USD',
    fxRateToBase: '4.05000000',
    source: 'massive',
    edited: false,
    note: null,
    ...overrides,
  };
}

/** The route's mapping, kept in one place so the test exercises it verbatim. */
function payload(rows: DividendPaymentRow[]) {
  const summary = summarizeDividends(rows, '2026-08-18').all;
  const years = groupPaymentsByYear(rows);
  return {
    payments: rows.map((r) => ({
      id: r.id,
      portfolioId: r.portfolioId,
      portfolioName: r.portfolioName,
      instrumentId: r.instrumentId,
      symbol: r.symbol,
      displayName: r.displayName,
      exDate: r.exDate,
      payDate: r.payDate,
      quantity: r.quantity,
      amountPerShare: r.amountPerShare,
      grossAmount: r.grossAmount,
      withheldTax: r.withheldTax,
      netAmount: toNumeric(dec(r.grossAmount).minus(dec(r.withheldTax))),
      currency: r.currency,
      fxRateToBase: r.fxRateToBase,
      source: r.source,
      edited: r.edited,
      note: r.note,
    })),
    years: years.map((g) => ({
      year: g.year,
      paymentIds: g.rows.map((r) => r.id),
      totals: g.totals,
      netPLN: g.netPLN,
      awaitingFx: g.awaitingFx,
      fxUnsupported: g.fxUnsupported,
    })),
    summary,
  };
}

describe('dividendsResponseSchema', () => {
  it('accepts what the folds actually produce', () => {
    const parsed = dividendsResponseSchema.parse(payload([row()]));

    expect(parsed.payments).toHaveLength(1);
    expect(parsed.years[0].year).toBe('2026');
    expect(parsed.years[0].paymentIds).toEqual([row().id]);
  });

  it('carries net as a server-derived string, never a number', () => {
    const parsed = dividendsResponseSchema.parse(payload([row()]));

    // 25 − 3.75. The phone must never subtract two money strings itself, so
    // the difference has to arrive already computed on Decimal.
    expect(dec(parsed.payments[0].netAmount).toString()).toBe('21.25');
    expect(typeof parsed.payments[0].netAmount).toBe('string');
  });

  it('keeps the two unrated counts apart', () => {
    const parsed = dividendsResponseSchema.parse(
      payload([
        // On the NBP allowlist, rate not published yet — the next sync fixes it.
        row({ id: '44444444-4444-4444-8444-444444444444', currency: 'USD', fxRateToBase: null }),
        // Outside the allowlist — no PLN route will EVER exist for this row,
        // and calling it "awaiting" would be a promise nothing can keep.
        row({ id: '55555555-5555-4555-8555-555555555555', currency: 'ZAR', fxRateToBase: null }),
      ]),
    );

    expect(parsed.summary.awaitingFx).toBe(1);
    expect(parsed.summary.fxUnsupported).toBe(1);
    // Nothing was summable, so the total is null rather than a quietly
    // smaller number that reads as the truth.
    expect(parsed.summary.netPLN).toBeNull();
  });

  it('rejects a payload whose year group references nothing', () => {
    const broken = payload([row()]);
    // A group id that is not a uuid is the shape a hand-written mapping
    // regresses into; the schema is what notices.
    broken.years[0].paymentIds = ['not-a-uuid'];

    expect(() => dividendsResponseSchema.parse(broken)).toThrow();
  });
});
