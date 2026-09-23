import { describe, expect, it } from 'vitest';

import { buildTransactionPrefill } from '@/lib/screenshots/transaction-prefill';
import type { TransactionScreenshotExtraction } from '@/lib/validation';

import { transactionImportResponseSchema } from './imports';

/** The route's one rename — see the schema's note on why `form` cannot keep
 *  that name once quicktype has turned it into a Swift type. */
function toWire(prefill: ReturnType<typeof buildTransactionPrefill>) {
  const { form, ...rest } = prefill;
  return { ...rest, formPrefill: form };
}

/**
 * THE anti-drift test for the importer — the `options-contract.test.ts`
 * arrangement.
 *
 * The phone decodes Swift generated from `transactionImportResponseSchema`,
 * while the route answers with whatever `buildTransactionPrefill` returns. A
 * note kind added to the builder but not the schema would ship a disclosure
 * the phone silently drops — and the notes are the whole HONESTY mechanism of
 * this feature: every one of them exists because the app inferred something
 * it might have got wrong. Losing one on the phone is not a cosmetic gap.
 *
 * So the real builder is run through the real schema, on the extractions that
 * produce the awkward notes.
 */

function extraction(
  overrides: Partial<TransactionScreenshotExtraction> = {},
): TransactionScreenshotExtraction {
  return {
    tickerCandidate: null,
    companyName: null,
    isinCandidate: null,
    exchange: null,
    side: null,
    sideEvidence: null,
    quantity: null,
    pricePerShare: null,
    priceCurrency: null,
    settlementCurrency: null,
    totalValue: null,
    totalValueCurrency: null,
    fees: null,
    feesCurrency: null,
    brokerFxRate: null,
    tradeDate: null,
    settlementDate: null,
    screenKind: null,
    brokerSymbolText: null,
    ...overrides,
  };
}

describe('transactionImportResponseSchema', () => {
  it('accepts a picture nothing could be read from', () => {
    // The honest answer to an unreadable screenshot is an empty prefill, not
    // a failure — the user still gets a blank form and a "side unknown" note.
    const parsed = transactionImportResponseSchema.parse(
      toWire(buildTransactionPrefill(extraction())),
    );

    expect(parsed.formPrefill.quantity).toBeNull();
    expect(parsed.readFields).toEqual([]);
  });

  it('accepts an ordinary buy', () => {
    const parsed = transactionImportResponseSchema.parse(
      toWire(buildTransactionPrefill(
        extraction({
          tickerCandidate: 'AAPL',
          side: 'buy',
          sideEvidence: 'kupno',
          quantity: '10',
          pricePerShare: '220.50',
          priceCurrency: 'USD',
          totalValue: '2205.00',
          totalValueCurrency: 'USD',
          tradeDate: '2026-08-14',
          screenKind: 'transaction',
        }),
      )),
    );

    expect(parsed.formPrefill.side).toBe('buy');
    expect(parsed.formPrefill.quantity).toBe('10');
    expect(parsed.readFields).toContain('quantity');
  });

  it('carries the position warning, which is the whole mitigation for that screen', () => {
    const parsed = transactionImportResponseSchema.parse(
      toWire(
        buildTransactionPrefill(
          extraction({ screenKind: 'position', quantity: '30', pricePerShare: '99.10' }),
        ),
      ),
    );

    const position = parsed.notes.find((note) => note.kind === 'position');
    expect(position).toBeDefined();
    // The figures ride along: the sentence names what it filled in, so the
    // user can recognise a position they built up over several buys.
    expect(position?.quantity).toBe('30');
    expect(position?.pricePerShare).toBe('99.10');
  });

  it('carries a fee conversion with its arithmetic intact', () => {
    const parsed = transactionImportResponseSchema.parse(
      toWire(buildTransactionPrefill(
        extraction({
          quantity: '10',
          pricePerShare: '100.00',
          priceCurrency: 'USD',
          totalValue: '4000.00',
          totalValueCurrency: 'PLN',
          brokerFxRate: '4.00',
          fees: '15.84',
          feesCurrency: 'PLN',
          side: 'buy',
        }),
      )),
    );

    const converted = parsed.notes.find((note) => note.kind === 'fee-converted');
    expect(converted?.shown).toMatchObject({ fromCurrency: 'PLN', toCurrency: 'USD' });
  });

  it('keeps the two unconverted-fee reasons distinguishable on the wire', () => {
    const parsed = transactionImportResponseSchema.parse(
      toWire(
        buildTransactionPrefill(extraction({ fees: '12.00', feesCurrency: 'PLN', side: 'buy' })),
      ),
    );

    const unconverted = parsed.notes.find((note) => note.kind === 'fee-unconverted');
    // 'no-rate' and 'unknown-target' must not collapse: telling someone there
    // is no rate while a rate is printed on the screenshot in front of them
    // is a confidently false explanation.
    expect(unconverted?.reason).toBe('no-rate');
  });

  it('rejects a note kind the schema has never heard of', () => {
    const prefill = buildTransactionPrefill(extraction());
    const broken = {
      ...toWire(prefill),
      notes: [...prefill.notes, { kind: 'invented-later' }],
    };

    expect(() => transactionImportResponseSchema.parse(broken)).toThrow();
  });
});
