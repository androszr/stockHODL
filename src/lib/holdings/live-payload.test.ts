import { describe, expect, it } from 'vitest';

import type { PriceTick } from '@/lib/market-data/provider';
import { dec, fmtMoney, fmtPct, pctChange } from '@/lib/money';

import {
  applyPriceTick,
  composeLivePayload,
  type HoldingQuote,
  type HoldingsInputs,
  type ScopedEngineTransaction,
} from './live-payload';

/**
 * The composition contract under streaming: a payload composed from the
 * baseline, then re-composed after a tick, must keep the coherent triple —
 * and the guards (wrong currency, missing FX) must survive the extraction
 * from live-view.ts unchanged.
 */

function buy(overrides: Partial<ScopedEngineTransaction> = {}): ScopedEngineTransaction {
  return {
    id: 't1',
    instrumentId: 'i1',
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

const TICK: PriceTick = { symbol: 'AAPL', price: '112', tMs: 1_754_800_000_000 };

describe('composeLivePayload — baseline composition', () => {
  it('composes formatted card and summary figures from the quotes map', () => {
    const payload = composeLivePayload(inputs(), new Map([['AAPL', quote()]]));

    expect(payload.holdings).toHaveLength(1);
    const h = payload.holdings[0];
    expect(h.price).toBe(fmtMoney(dec('110'), 'USD'));
    expect(h.dayPct?.text).toBe(fmtPct(dec(quote().dayChangePct!)));
    expect(h.dayPct?.direction).toBe('gain');
    // 10 × 110 × 4 = 4400 PLN.
    expect(h.valuePLN).toBe(fmtMoney(dec('4400'), 'PLN'));
    expect(payload.summary.totalValue).toBe(fmtMoney(dec('4400'), 'PLN'));
    // Day move: 10 × 5 × 4 = 200 PLN.
    expect(payload.summary.dayChange?.text).toContain(fmtMoney(dec('200'), 'PLN'));
    expect(payload.summary.excludedSymbols).toEqual([]);
    expect(payload.hasPollableSymbols).toBe(true);
    expect(payload.market.status).toBe('open');
  });

  it('passes a stale extended reading through with its end instant', () => {
    const endedAt = 1_754_611_200_000; // epoch ms — a timestamp, not money
    const payload = composeLivePayload(
      inputs(),
      new Map([
        [
          'AAPL',
          quote({ extendedKind: 'late', extendedChangePct: '-0.0255', extendedEndedAtMs: endedAt }),
        ],
      ]),
    );
    expect(payload.holdings[0].extended).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: endedAt,
      text: fmtPct(dec('-0.0255')),
      direction: 'loss',
    });
  });

  it('a live extended reading crosses with endedAtMs null — no invented instant', () => {
    const payload = composeLivePayload(
      inputs(),
      new Map([
        ['AAPL', quote({ extendedKind: 'early', extendedChangePct: '0.5', extendedLive: true })],
      ]),
    );
    expect(payload.holdings[0].extended).toMatchObject({
      kind: 'early',
      live: true,
      endedAtMs: null,
    });
  });

  it('quoteFigures passes the liveness fact through unchanged — ended-unvouched stays ended', () => {
    // The case the liveness field exists for: ended session, unvouched
    // instant — both endedAtMs AND live must cross as-is, never conflated.
    const payload = composeLivePayload(
      inputs(),
      new Map([
        ['AAPL', quote({ extendedKind: 'late', extendedChangePct: '-0.5', extendedLive: false })],
      ]),
    );
    expect(payload.holdings[0].extended).toMatchObject({
      kind: 'late',
      live: false,
      endedAtMs: null,
    });
  });

  it('a wrong-currency quote is excluded, never multiplied by the wrong FX rate', () => {
    const payload = composeLivePayload(
      inputs(),
      new Map([['AAPL', quote({ currency: 'PLN' })]]),
    );
    expect(payload.holdings[0].price).toBeNull();
    expect(payload.holdings[0].valuePLN).toBeNull();
    expect(payload.summary.totalValue).toBeNull();
    expect(payload.summary.excludedSymbols).toEqual(['AAPL']);
  });

  it('a missing FX rate excludes the position — "—", never a fake PLN value', () => {
    const payload = composeLivePayload(
      inputs({ fxRates: new Map() }),
      new Map([['AAPL', quote()]]),
    );
    expect(payload.holdings[0].valuePLN).toBeNull();
    expect(payload.holdings[0].unrealizedPLN).toBeNull();
    expect(payload.summary.excludedSymbols).toEqual(['AAPL']);
  });
});

describe('composeLivePayload — raw sort keys travel beside the formatted figures', () => {
  it('emits dec()-parseable raw twins consistent with the Decimal inputs', () => {
    const payload = composeLivePayload(inputs(), new Map([['AAPL', quote()]]));
    const h = payload.holdings[0];

    // 10 × 110 × 4 = 4400 PLN; basis 10 × 100 × 4 = 4000 → unrealized 400.
    expect(h.valuePLNRaw).not.toBeNull();
    expect(dec(h.valuePLNRaw!).equals(dec('4400'))).toBe(true);
    expect(h.unrealizedPLNRaw).not.toBeNull();
    expect(dec(h.unrealizedPLNRaw!).equals(dec('400'))).toBe(true);
  });

  it('wrong-currency quote: raw fields are null exactly when the formatted ones are', () => {
    const payload = composeLivePayload(
      inputs(),
      new Map([['AAPL', quote({ currency: 'PLN' })]]),
    );
    const h = payload.holdings[0];
    expect(h.valuePLN).toBeNull();
    expect(h.valuePLNRaw).toBeNull();
    expect(h.unrealizedPLN).toBeNull();
    expect(h.unrealizedPLNRaw).toBeNull();
  });

  it('missing FX rate: raw fields null in lockstep', () => {
    const payload = composeLivePayload(inputs({ fxRates: new Map() }), new Map([['AAPL', quote()]]));
    const h = payload.holdings[0];
    expect(h.valuePLN).toBeNull();
    expect(h.valuePLNRaw).toBeNull();
    expect(h.unrealizedPLN).toBeNull();
    expect(h.unrealizedPLNRaw).toBeNull();
  });

  it('zero-quantity oversold row: raw fields null in lockstep despite a usable quote', () => {
    // A sell entered before its buy — clamped to zero, flagged, still displayed.
    const payload = composeLivePayload(
      inputs({ engineTxs: [buy({ side: 'sell' })] }),
      new Map([['AAPL', quote()]]),
    );
    expect(payload.holdings).toHaveLength(1);
    const h = payload.holdings[0];
    expect(h.valuePLN).toBeNull();
    expect(h.valuePLNRaw).toBeNull();
    expect(h.unrealizedPLN).toBeNull();
    expect(h.unrealizedPLNRaw).toBeNull();
  });
});

describe('composeLivePayload — cached-price fallback (display-only)', () => {
  const CACHED = new Map([
    ['AAPL', { price: '108.50000000', currency: 'USD', fetchedAtMs: 1_755_340_800_000 }],
  ]);

  it('appears ONLY when the live price is null — never beside a live price', () => {
    const withLive = composeLivePayload(
      inputs({ cachedQuotes: CACHED }),
      new Map([['AAPL', quote()]]),
    );
    expect(withLive.holdings[0].price).not.toBeNull();
    expect(withLive.holdings[0].cachedPrice).toBeNull();

    const withoutLive = composeLivePayload(inputs({ cachedQuotes: CACHED }), new Map());
    const h = withoutLive.holdings[0];
    expect(h.price).toBeNull();
    expect(h.cachedPrice).toEqual({
      text: fmtMoney(dec('108.5'), 'USD'),
      asOfMs: 1_755_340_800_000,
    });
    // Display-only: the totals never price from a stale row — the symbol
    // stays honestly excluded and the day pair stays null.
    expect(withoutLive.summary.totalValue).toBeNull();
    expect(withoutLive.summary.excludedSymbols).toEqual(['AAPL']);
    expect(h.dayPct).toBeNull();
    expect(h.valuePLN).toBeNull();
  });

  it('a currency-mismatched cache entry is ignored — the dash, never the wrong unit', () => {
    const payload = composeLivePayload(
      inputs({
        cachedQuotes: new Map([
          ['AAPL', { price: '108.5', currency: 'PLN', fetchedAtMs: 123 }],
        ]),
      }),
      new Map(),
    );
    expect(payload.holdings[0].price).toBeNull();
    expect(payload.holdings[0].cachedPrice).toBeNull();
  });

  it('a wrong-currency LIVE quote still falls back to a matching cached row', () => {
    // The live quote is unusable (guard), so the cached price is the honest
    // best available figure.
    const payload = composeLivePayload(
      inputs({ cachedQuotes: CACHED }),
      new Map([['AAPL', quote({ currency: 'PLN' })]]),
    );
    expect(payload.holdings[0].price).toBeNull();
    expect(payload.holdings[0].cachedPrice).not.toBeNull();
  });

  it('no cachedQuotes input → cachedPrice is null, byte-identical to before', () => {
    const payload = composeLivePayload(inputs(), new Map());
    expect(payload.holdings[0].cachedPrice).toBeNull();
  });
});

describe('applyPriceTick — the coherent triple survives a streamed tick', () => {
  it('open: the tick moves the headline and re-derives the day pair from the same baseline', () => {
    const base = new Map([['AAPL', quote()]]);
    const next = applyPriceTick(base, TICK, 'open');

    // Never mutates the input map.
    expect(base.get('AAPL')!.price).toBe('110');

    const updated = next.get('AAPL')!;
    expect(updated.price).toBe('112');
    expect(updated.dayChangeAmt).toBe(dec('112').minus(dec('105')).toString());
    expect(updated.dayChangePct).toBe(pctChange(dec('105'), dec('112'))!.toString());

    // Re-composition renders the invariant: same pctChange, moved value.
    const payload = composeLivePayload(inputs(), next);
    expect(payload.holdings[0].price).toBe(fmtMoney(dec('112'), 'USD'));
    expect(payload.holdings[0].dayPct?.text).toBe(fmtPct(pctChange(dec('105'), dec('112'))));
    // 10 × 112 × 4 = 4480; day move 10 × 7 × 4 = 280.
    expect(payload.holdings[0].valuePLN).toBe(fmtMoney(dec('4480'), 'PLN'));
    expect(payload.summary.dayChange?.text).toContain(fmtMoney(dec('280'), 'PLN'));
  });

  it('open with no baseline: a moved price nulls the pair rather than showing a stale one', () => {
    const next = applyPriceTick(new Map([['AAPL', quote({ prevClose: null })]]), TICK, 'open');
    const updated = next.get('AAPL')!;
    expect(updated.price).toBe('112');
    expect(updated.dayChangeAmt).toBeNull();
    expect(updated.dayChangePct).toBeNull();
  });

  it('extended sessions: the headline stays the close; the tick moves the extended line', () => {
    const base = new Map([['AAPL', quote()]]);
    const next = applyPriceTick(base, TICK, 'late_trading');
    const updated = next.get('AAPL')!;
    // The big number is still the official close…
    expect(updated.price).toBe('110');
    expect(updated.dayChangeAmt).toBe(quote().dayChangeAmt);
    // …and the after-hours line tracks the tick, close → tick.
    expect(updated.extendedKind).toBe('late');
    expect(updated.extendedChangePct).toBe(pctChange(dec('110'), dec('112'))!.toString());

    const early = applyPriceTick(base, TICK, 'early_trading').get('AAPL')!;
    expect(early.extendedKind).toBe('early');
  });

  it('a live extended tick pins endedAtMs to null — never resurrecting a stale label', () => {
    // A baseline carrying Friday's stale after-hours reading, then a live
    // after-hours tick: the reading is live again, so the instant must drop
    // AND the liveness fact must flip — both fields, never one without the other.
    const base = new Map([
      ['AAPL', quote({ extendedKind: 'late', extendedChangePct: '-0.5', extendedEndedAtMs: 123 })],
    ]);
    const updated = applyPriceTick(base, TICK, 'late_trading').get('AAPL')!;
    expect(updated.extendedKind).toBe('late');
    expect(updated.extendedEndedAtMs).toBeNull();
    expect(updated.extendedLive).toBe(true);
  });

  it('a tick while closed is a no-op — a stale reading and its instant survive untouched', () => {
    const base = new Map([
      ['AAPL', quote({ extendedKind: 'late', extendedChangePct: '-0.5', extendedEndedAtMs: 123 })],
    ]);
    expect(applyPriceTick(base, TICK, 'closed')).toBe(base);
    expect(base.get('AAPL')!.extendedEndedAtMs).toBe(123);
    expect(base.get('AAPL')!.extendedLive).toBe(false);
  });

  it('the day-stats fields ride through a tick untouched — REST cadence only', () => {
    const base = new Map([
      [
        'AAPL',
        quote({
          dayOpen: '104.9',
          dayHigh: '112.4',
          dayLow: '104.1',
          dayVolume: 987654,
          vwap: '108.2',
        }),
      ],
    ]);
    const updated = applyPriceTick(base, TICK, 'open').get('AAPL')!;
    expect(updated.price).toBe('112');
    // The spread preserves the session fields verbatim — a tick moves the
    // price, never the day's range.
    expect(updated.dayOpen).toBe('104.9');
    expect(updated.dayHigh).toBe('112.4');
    expect(updated.dayLow).toBe('104.1');
    expect(updated.dayVolume).toBe(987654);
    expect(updated.vwap).toBe('108.2');
  });

  it('matches vendor-uppercase tick symbols to stored keys case-insensitively', () => {
    const next = applyPriceTick(
      new Map([['aapl', quote()]]),
      { ...TICK, symbol: 'AAPL' },
      'open',
    );
    expect(next.get('aapl')!.price).toBe('112');
  });

  it('unknown symbols and non-streaming statuses return the input map untouched', () => {
    const base = new Map([['AAPL', quote()]]);
    expect(applyPriceTick(base, { ...TICK, symbol: 'MSFT' }, 'open')).toBe(base);
    expect(applyPriceTick(base, TICK, 'closed')).toBe(base);
    expect(applyPriceTick(base, TICK, 'unknown')).toBe(base);
  });
});

/**
 * Per-portfolio scopes (2026-08-14, Portfolios folded into Holdings). The
 * property that matters is that a scope is the SAME arithmetic as the total,
 * run over fewer rows — so these assert the relationship, not just shapes.
 */
describe('composeLivePayload — portfolio scopes', () => {
  const A = buy({ id: 't1', portfolioId: 'p1' });
  const B = buy({
    id: 't2',
    instrumentId: 'i2',
    symbol: 'MSFT',
    displayName: 'Microsoft',
    quantity: '5',
    portfolioId: 'p2',
  });
  const QUOTES = new Map([
    ['AAPL', quote()],
    ['MSFT', quote()],
  ]);

  it('emits no scopes at all when the caller supplies no portfolio list', () => {
    // The ticker page and the watchlist want exactly this — nothing to pay for.
    expect(composeLivePayload(inputs(), QUOTES).scopes).toEqual([]);
  });

  it('emits one scope per portfolio, in the given order, empty ones included', () => {
    const payload = composeLivePayload(
      inputs({
        engineTxs: [A, B],
        portfolios: [
          { id: 'p2', name: 'Broker' },
          { id: 'p1', name: 'IKE' },
          { id: 'p3', name: 'Empty' },
        ],
      }),
      QUOTES,
    );

    expect(payload.scopes.map((s) => s.id)).toEqual(['p2', 'p1', 'p3']);
    expect(payload.scopes[0].holdings.map((h) => h.instrumentId)).toEqual(['i2']);
    expect(payload.scopes[1].holdings.map((h) => h.instrumentId)).toEqual(['i1']);
    // A portfolio holding nothing gets an honest empty slice, not a missing one.
    expect(payload.scopes[2].holdings).toEqual([]);
    expect(payload.scopes[2].summary.totalValue).toBeNull();
  });

  it('gives a scoped position the identical figures the total gives it', () => {
    const payload = composeLivePayload(
      inputs({ engineTxs: [A, B], portfolios: [{ id: 'p1', name: 'IKE' }] }),
      QUOTES,
    );

    const inTotal = payload.holdings.find((h) => h.instrumentId === 'i1');
    expect(payload.scopes[0].holdings[0]).toEqual(inTotal);
  });

  it('scopes the summary too — a scope never reports the whole portfolio', () => {
    const payload = composeLivePayload(
      inputs({
        engineTxs: [A, B],
        portfolios: [
          { id: 'p1', name: 'IKE' },
          { id: 'p2', name: 'Broker' },
        ],
      }),
      QUOTES,
    );

    // 10 × 110 × 4.00 and 5 × 110 × 4.00 — the two scopes sum to the total,
    // and neither one carries it on its own.
    expect(payload.scopes[0].summary.totalValue).not.toEqual(payload.summary.totalValue);
    expect(payload.scopes[1].summary.totalValue).not.toEqual(payload.summary.totalValue);
    expect(payload.summary.totalValue).toBe(fmtMoney(dec('6600'), 'PLN'));
    expect(payload.scopes[0].summary.totalValue).toBe(fmtMoney(dec('4400'), 'PLN'));
    expect(payload.scopes[1].summary.totalValue).toBe(fmtMoney(dec('2200'), 'PLN'));
  });
});
