import { describe, expect, it } from 'vitest';

import type { OptionScreenshotExtraction } from '@/lib/validation';

import { normalizeExtraction } from './screenshot-parse';

/**
 * Unit tests for the OPTIONS extraction belt. The golden fixtures are
 * written the way a Saxo Bank option screen prints them (`15-sty-2027`,
 * `06-sie-2026`, `18,35`, `240,00`, `SNOW/15F27C240:xcbf`) — the layout is
 * real, the lot is invented.
 *
 * The shared helpers this leans on (`sniffImageType`, `normalizeDateToISO`,
 * `normalizeMoneyString`, the ticker candidates) are tested in
 * `src/lib/screenshots/normalize.test.ts`, where they now live.
 */

function allNull(): OptionScreenshotExtraction {
  return {
    underlyingTickerCandidate: null,
    companyName: null,
    contractType: null,
    strikePrice: null,
    expirationDate: null,
    quantity: null,
    entryPrice: null,
    tradeDate: null,
    fees: null,
    feesCurrency: null,
    brokerSymbolText: null,
  };
}

describe('normalizeExtraction — the belt over the model output', () => {
  it('normalizes the full Saxo reference extraction to the golden values', () => {
    const normalized = normalizeExtraction({
      underlyingTickerCandidate: 'SNOW',
      companyName: 'Snowflake Inc.',
      contractType: 'call',
      strikePrice: '240,00',
      expirationDate: '15-sty-2027',
      quantity: '1',
      entryPrice: '18,35',
      tradeDate: '06-sie-2026',
      fees: '1,96',
      feesCurrency: 'usd',
      brokerSymbolText: 'SNOW/15F27C240:xcbf',
    });
    expect(normalized).toEqual({
      underlyingTickerCandidate: 'SNOW',
      companyName: 'Snowflake Inc.',
      contractType: 'call',
      strikePrice: '240.00',
      expirationDate: '2027-01-15',
      quantity: '1',
      entryPrice: '18.35',
      tradeDate: '2026-08-06',
      fees: '1.96',
      feesCurrency: 'USD',
      brokerSymbolText: 'SNOW/15F27C240:xcbf',
    });
  });

  it('falls back to the broker-symbol ticker when the primary candidate is unusable', () => {
    const normalized = normalizeExtraction({
      ...allNull(),
      underlyingTickerCandidate: 'not a ticker',
      brokerSymbolText: 'SNOW/15F27C240:xcbf',
    });
    expect(normalized.underlyingTickerCandidate).toBe('SNOW');
  });

  it('keeps an all-null extraction all-null — no fake zeros anywhere', () => {
    expect(normalizeExtraction(allNull())).toEqual(allNull());
  });

  it('nulls out what it cannot normalize instead of passing garbage on', () => {
    const normalized = normalizeExtraction({
      ...allNull(),
      expirationDate: 'next friday',
      feesCurrency: 'dollars',
    });
    expect(normalized.expirationDate).toBeNull();
    expect(normalized.feesCurrency).toBeNull();
  });
});
