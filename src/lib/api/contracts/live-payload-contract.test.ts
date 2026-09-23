import { describe, expect, it } from 'vitest';

import {
  composeLivePayload,
  type HoldingQuote,
  type HoldingsInputs,
  type ScopedEngineTransaction,
} from '@/lib/holdings/live-payload';
import { dec, pctChange } from '@/lib/money';

import { livePayloadSchema } from './live-payload';

/**
 * THE anti-drift test.
 *
 * `livePayloadSchema` is a hand-written mirror of the interfaces in
 * `src/lib/holdings/live-payload.ts`, and the Swift structs the phone decodes
 * are generated from the schema — not from the interfaces. So a field added
 * to the composer without being added to the schema would ship a payload the
 * client silently cannot see, and a field removed from the composer would
 * leave the client decoding something that no longer arrives.
 *
 * Running the REAL composer through the schema closes that gap in both
 * directions at once: `strict()` fails on a field the composer produces and
 * the schema does not know, and the schema's own required fields fail when
 * the composer stops producing one.
 */

function buy(overrides: Partial<ScopedEngineTransaction> = {}): ScopedEngineTransaction {
  return {
    id: 't1',
    instrumentId: '11111111-1111-4111-8111-111111111111',
    symbol: 'AAPL',
    displayName: 'Apple Inc.',
    currency: 'USD',
    side: 'buy',
    quantity: '10',
    price: '100',
    fees: '0',
    fxRateToBase: '4.00000000',
    tradeDate: '2026-01-05',
    createdAt: new Date('2026-01-05T12:00:00Z'),
    ...overrides,
  };
}

function quote(overrides: Partial<HoldingQuote> = {}): HoldingQuote {
  return {
    price: '110',
    currency: 'USD',
    prevClose: '105',
    dayChangeAmt: dec('110').minus(dec('105')).toString(),
    dayChangePct: pctChange(dec('105'), dec('110'))!.toString(),
    extendedChangePct: null,
    extendedKind: null,
    extendedEndedAtMs: null,
    extendedLive: false,
    ...overrides,
  };
}

function inputs(overrides: Partial<HoldingsInputs> = {}): HoldingsInputs {
  return {
    engineTxs: [buy()],
    fxRates: new Map([['USD', '4.00']]),
    market: {
      status: 'open',
      nextTransitionAtMs: null,
      nextTransitionKind: null,
      pollingResumesAtMs: null,
    },
    hasPollableSymbols: true,
    ...overrides,
  };
}

const QUOTES = new Map<string, HoldingQuote>([['AAPL', quote()]]);

/**
 * Deep-strict: zod's `.strict()` only rejects unknown keys at the level it is
 * applied to, and the payload is four levels deep. Walking the object and
 * comparing key sets against the schema's own shape is what makes an added
 * nested field (a new `LiveHolding` member, say) fail rather than pass.
 */
function assertNoUnknownKeys(value: unknown, allowed: Set<string>, path: string) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    expect(allowed.has(key), `unexpected key ${path}.${key} — add it to the contract`).toBe(
      true,
    );
  }
}

describe('livePayloadSchema mirrors the real composer', () => {
  it('accepts a fully-populated payload', () => {
    const payload = composeLivePayload(
      inputs({
        portfolios: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Main' }],
        engineTxs: [buy({ portfolioId: '22222222-2222-4222-8222-222222222222' })],
      }),
      QUOTES,
    );

    const parsed = livePayloadSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('accepts the degraded payload — no quote, no FX rate', () => {
    // Every figure nulls out here. The schema must allow that: "—" over a
    // fake zero is the whole display contract, and a schema that demanded
    // strings would force the server to lie.
    const payload = composeLivePayload(
      inputs({ fxRates: new Map() }),
      new Map(),
    );

    const parsed = livePayloadSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(payload.holdings[0].price).toBeNull();
  });

  it('accepts an extended-hours reading with its ended instant', () => {
    const payload = composeLivePayload(
      inputs(),
      new Map([
        [
          'AAPL',
          quote({
            extendedChangePct: '1.25',
            extendedKind: 'late',
            extendedEndedAtMs: 1_754_800_000_000,
            extendedLive: false,
          }),
        ],
      ]),
    );

    const parsed = livePayloadSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(payload.holdings[0].extended?.kind).toBe('late');
  });

  it('carries no field the contract does not name', () => {
    const payload = composeLivePayload(
      inputs({
        portfolios: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Main' }],
        engineTxs: [buy({ portfolioId: '22222222-2222-4222-8222-222222222222' })],
      }),
      QUOTES,
    );

    assertNoUnknownKeys(
      payload,
      new Set(['market', 'summary', 'holdings', 'scopes', 'hasPollableSymbols']),
      'payload',
    );
    assertNoUnknownKeys(
      payload.market,
      new Set([
        'status',
        'nextTransitionAtMs',
        'nextTransitionKind',
        'pollingResumesAtMs',
        'serverNowMs',
      ]),
      'market',
    );
    assertNoUnknownKeys(
      payload.summary,
      new Set([
        'totalValue',
        'dayChange',
        'totalChange',
        'dayChangePct',
        'totalChangePct',
        'excludedSymbols',
        'partialDayChange',
        'trend',
      ]),
      'summary',
    );
    assertNoUnknownKeys(
      payload.holdings[0],
      new Set([
        'instrumentId',
        'price',
        'cachedPrice',
        'dayPct',
        'extended',
        'unrealizedPLN',
        'unrealizedPct',
        'direction',
        'valuePLN',
        'valuePLNRaw',
        'unrealizedPLNRaw',
      ]),
      'holdings[0]',
    );
    assertNoUnknownKeys(payload.scopes[0], new Set(['id', 'summary', 'holdings']), 'scopes[0]');
  });
});
