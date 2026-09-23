import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';

import {
  optionScreenshotExtractionSchema,
  transactionExtractionFromWire,
  transactionScreenshotExtractionSchema,
  transactionScreenshotWireSchema,
  type TransactionScreenshotWire,
} from '@/lib/validation';

/**
 * The vendor CONTRACT, tested without the vendor: what `zodOutputFormat`
 * compiles each schema into is a pure function of the schema, so the one
 * failure that took the whole transaction import down in production — a 400
 * before the image was ever read — is reproducible offline.
 *
 * Structured outputs refuse a schema with more than sixteen union-typed
 * parameters. `.nullable()` is a union; nineteen nullable fields were twenty
 * per cent over the line. This file is the tripwire: add a nullable field to
 * a schema the model is asked for and it fails here, in a second, instead of
 * on a phone in front of a broker screen.
 */

/** Every `anyOf` / `oneOf` / type-array node, at any depth — the same thing
 *  the API counts when it compiles the schema. */
function countUnionParameters(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0;

  const record = node as Record<string, unknown>;
  const isUnion =
    Array.isArray(record.type) || Array.isArray(record.anyOf) || Array.isArray(record.oneOf);

  return (
    (isUnion ? 1 : 0) +
    Object.values(record).reduce<number>((sum, value) => sum + countUnionParameters(value), 0)
  );
}

function jsonSchemaFor(schema: Parameters<typeof zodOutputFormat>[0]): unknown {
  const format = zodOutputFormat(schema) as { schema?: unknown };
  return format.schema ?? format;
}

/** The API's documented ceiling, quoted in the 400 that caused this file. */
const UNION_LIMIT = 16;

describe('what the model is actually asked for', () => {
  it('keeps the transaction contract clear of the union limit', () => {
    const unions = countUnionParameters(jsonSchemaFor(transactionScreenshotWireSchema));
    // Zero, not merely "under sixteen": absence rides on the empty string, so
    // the nineteenth field costs nothing and neither will the twentieth.
    expect(unions).toBe(0);
    expect(unions).toBeLessThanOrEqual(UNION_LIMIT);
  });

  it('keeps the option contract clear of the union limit', () => {
    // Eleven nullable fields — the reason this import kept working while the
    // transaction one was dead. Guarded so it stays that way.
    expect(countUnionParameters(jsonSchemaFor(optionScreenshotExtractionSchema))).toBeLessThanOrEqual(
      UNION_LIMIT,
    );
  });

  it('proves the shape the wire schema replaced would still be refused', () => {
    // Not a regression guard — the record of WHY the wire schema exists.
    expect(countUnionParameters(jsonSchemaFor(transactionScreenshotExtractionSchema))).toBe(19);
  });

  it('asks for every field the app consumes — no silent narrowing', () => {
    expect(Object.keys(transactionScreenshotWireSchema.shape).sort()).toEqual(
      Object.keys(transactionScreenshotExtractionSchema.shape).sort(),
    );
  });
});

describe('transactionExtractionFromWire — the empty string is absence', () => {
  const wire: TransactionScreenshotWire = {
    tickerCandidate: 'PANW',
    companyName: 'Palo Alto Networks Inc.',
    isinCandidate: '',
    exchange: 'NASDAQ',
    side: '',
    sideEvidence: '',
    quantity: '8',
    pricePerShare: '182,40',
    priceCurrency: 'USD',
    settlementCurrency: 'PLN',
    totalValue: '-1 459,20',
    totalValueCurrency: 'USD',
    fees: '2,00',
    feesCurrency: 'USD',
    brokerFxRate: '3,69120455',
    tradeDate: '24-sie-2026 18:41:07',
    settlementDate: '25-sie-2026',
    screenKind: 'position',
    brokerSymbolText: 'PANW:xnas',
  };

  it('turns every empty field into null, enums included', () => {
    const extraction = transactionExtractionFromWire(wire);

    expect(extraction.isinCandidate).toBeNull();
    expect(extraction.side).toBeNull();
    expect(extraction.sideEvidence).toBeNull();
    // A model with nothing to say sometimes says ' '.
    expect(transactionExtractionFromWire({ ...wire, exchange: '   ' }).exchange).toBeNull();
    expect(transactionExtractionFromWire({ ...wire, screenKind: '' }).screenKind).toBeNull();
  });

  it('passes every stated value through untouched, for the normalizer to judge', () => {
    const extraction = transactionExtractionFromWire(wire);

    expect(extraction.tickerCandidate).toBe('PANW');
    expect(extraction.side).toBeNull();
    expect(extraction.screenKind).toBe('position');
    // Raw, comma-decimal, sign intact — normalization is a later, separate step.
    expect(extraction.totalValue).toBe('-1 459,20');
    expect(extraction.tradeDate).toBe('24-sie-2026 18:41:07');
    expect(transactionExtractionFromWire({ ...wire, side: 'sell' }).side).toBe('sell');
  });

  it('produces a shape the persistence-boundary re-validation accepts', () => {
    expect(
      transactionScreenshotExtractionSchema.safeParse(transactionExtractionFromWire(wire)).success,
    ).toBe(true);
  });
});
