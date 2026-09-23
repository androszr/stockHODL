import { describe, expect, it } from 'vitest';

import type { MarketSessionInfo } from '@/lib/market-data/provider';
import type { OptionQuote, OptionQuoteOutcome } from '@/lib/market-data/options-types';
import {
  composeOptionsPayload,
  type OptionPositionRow,
} from '@/lib/options/options-payload';

import { optionsPayloadSchema } from './options';

/**
 * THE anti-drift test for the options half — the `live-payload-contract.test.ts`
 * arrangement, for the same reason.
 *
 * `optionsPayloadSchema` is a hand-written mirror of the interfaces in
 * `src/lib/options/options-payload.ts`, and the Swift structs the phone
 * decodes are generated from the SCHEMA, not from the interfaces. So a field
 * added to the composer but not the schema would ship a payload the client
 * silently cannot see, and a field dropped from the composer would leave the
 * client decoding something that no longer arrives.
 *
 * Running the REAL composer through the schema closes both directions at
 * once. `OptionCardItem` has 30+ fields, which is exactly the size at which
 * hand-checking stops working.
 */

const TICKER = 'O:AAPL260904C00220000';

/** 2026-08-14 08:00 ET — NY calendar date 2026-08-14. */
const NOW_MS = Date.UTC(2026, 7, 14, 12);

const MARKET: MarketSessionInfo = {
  status: 'open',
  nextTransitionAtMs: null,
  nextTransitionKind: null,
  pollingResumesAtMs: null,
};

function row(overrides: Partial<OptionPositionRow> = {}): OptionPositionRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    ticker: TICKER,
    underlying: 'AAPL',
    contractType: 'call',
    strikePrice: '220.00000000',
    expirationDate: '2026-09-04',
    sharesPerContract: '100.00000000',
    quantity: '2.00000000',
    entryPrice: '3.50000000',
    tradeDate: '2026-08-10',
    fees: '1.02000000',
    ...overrides,
  };
}

function quote(overrides: Partial<OptionQuote> = {}): OptionQuoteOutcome {
  return {
    ok: true,
    quote: {
      ticker: TICKER,
      underlying: 'AAPL',
      price: '5',
      prevClose: '4',
      dayChangeAmt: '1',
      dayChangePct: '25',
      marketStatus: 'open',
      greeks: { delta: '0.64', gamma: '0.01', theta: '-0.05', vega: '0.22' },
      impliedVolatility: '0.29',
      openInterest: 1500,
      contractType: 'call',
      strikePrice: '220',
      expirationDate: '2026-09-04',
      sharesPerContract: '100',
      asOf: new Date(NOW_MS),
      asOfSource: 'fetch',
      delaySeconds: 900,
      source: 'massive',
      ...overrides,
    },
  };
}

function parse(payload: unknown) {
  const parsed = optionsPayloadSchema.safeParse(payload);
  expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
  if (!parsed.success) {
    throw new Error('optionsPayloadSchema rejected the payload');
  }
  return parsed.data;
}

describe('optionsPayloadSchema mirrors the real composer', () => {
  it('accepts a fully-populated payload', () => {
    const payload = composeOptionsPayload([row()], new Map([[TICKER, quote()]]), MARKET, NOW_MS);
    const parsed = parse(payload);
    expect(typeof parsed.items[0].totalCost).toBe('string');
  });

  it('accepts the degraded payload — no quote at all', () => {
    // Every figure dashes out here. The schema must allow that: an em-dash
    // over a fake zero is the whole display contract, and a schema demanding
    // strings-that-are-numbers would force the server to lie about a thinly
    // traded contract.
    const payload = composeOptionsPayload([row()], new Map(), MARKET, NOW_MS);
    parse(payload);
    expect(payload.items[0].hasQuote).toBe(false);
    expect(payload.items[0].price).toBeNull();
    expect(payload.items[0].valueRaw).toBeNull();
  });

  it('accepts an aggregate card — two lots of one contract', () => {
    const payload = composeOptionsPayload(
      [
        row(),
        row({
          id: '44444444-4444-4444-8444-444444444444',
          quantity: '1.00000000',
          entryPrice: '4.10000000',
          tradeDate: '2026-08-12',
        }),
      ],
      new Map([[TICKER, quote()]]),
      MARKET,
      NOW_MS,
    );
    parse(payload);
    // The lots array is what every mutation addresses; a schema that let it
    // through empty would let the phone build a card nothing can edit.
    expect(payload.items[0].lots).toHaveLength(2);
    expect(payload.items[0].entryIsAverage).toBe(true);
  });

  it('accepts an expired contract and its expired count', () => {
    const payload = composeOptionsPayload(
      [row({ expirationDate: '2026-07-04' })],
      new Map([[TICKER, quote()]]),
      MARKET,
      NOW_MS,
    );
    parse(payload);
    expect(payload.items[0].expired).toBe(true);
    expect(payload.expiredCount).toBe(1);
    expect(payload.items[0].daysToExpiry).toBeLessThan(0);
  });

  it('accepts an empty book', () => {
    const payload = composeOptionsPayload([], new Map(), MARKET, NOW_MS);
    parse(payload);
    expect(payload.items).toEqual([]);
  });

  it('carries no card field the contract does not name', () => {
    const payload = composeOptionsPayload([row()], new Map([[TICKER, quote()]]), MARKET, NOW_MS);

    // zod's `.strict()` only rejects unknown keys at the level it is applied
    // to, and a card is two levels down. Comparing key sets directly is what
    // makes a NEW `OptionCardItem` member fail here rather than pass.
    const cardKeys = new Set(Object.keys(optionCardShape()));
    for (const key of Object.keys(payload.items[0])) {
      expect(cardKeys.has(key), `unexpected card key "${key}" — add it to the contract`).toBe(
        true,
      );
    }

    const lotKeys = new Set(Object.keys(optionLotShape()));
    for (const key of Object.keys(payload.items[0].lots[0])) {
      expect(lotKeys.has(key), `unexpected lot key "${key}" — add it to the contract`).toBe(
        true,
      );
    }
  });

  it('names every card field the composer produces', () => {
    const payload = composeOptionsPayload([row()], new Map([[TICKER, quote()]]), MARKET, NOW_MS);
    const produced = new Set(Object.keys(payload.items[0]));

    // The other direction: a schema field the composer stopped producing
    // would leave the phone decoding a key that never arrives.
    for (const key of Object.keys(optionCardShape())) {
      expect(produced.has(key), `contract names "${key}" but the composer does not`).toBe(true);
    }
  });
});

function optionCardShape(): Record<string, unknown> {
  return optionsPayloadSchema.shape.items.element.shape;
}

function optionLotShape(): Record<string, unknown> {
  return optionCardShape().lots instanceof Object
    ? optionsPayloadSchema.shape.items.element.shape.lots.element.shape
    : {};
}
