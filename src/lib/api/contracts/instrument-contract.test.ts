import { describe, expect, it } from 'vitest';

import { dayStatsFigures, type HoldingQuote } from '@/lib/holdings/live-payload';

import { dayStatsSchema, instrumentResponseSchema } from './instrument';
import { settingsResponseSchema } from './settings';

/**
 * Anti-drift for the two payloads added when the instrument screen and
 * Settings were ported to the phone. Both carry SERVER-formatted strings, and
 * both have exactly one producer — so the test runs the real producer through
 * the real schema rather than asserting a hand-written literal.
 */

function quote(overrides: Partial<HoldingQuote> = {}): HoldingQuote {
  return {
    price: '231.10',
    currency: 'USD',
    prevClose: '228.00',
    dayChangeAmt: '3.10',
    dayChangePct: '1.36',
    dayOpen: '229.00',
    dayHigh: '232.40',
    dayLow: '228.50',
    dayVolume: 41_235_900,
    vwap: '230.75',
    extendedChangePct: null,
    extendedKind: null,
    extendedEndedAtMs: null,
    ...overrides,
  } as HoldingQuote;
}

describe('day stats travel as formatted strings, never numbers', () => {
  it('accepts what the shared formatter produces', () => {
    const parsed = dayStatsSchema.parse(dayStatsFigures(quote(), 'USD'));
    // Money is pl-PL formatted on the server; the phone renders it verbatim.
    expect(parsed.prevClose).toContain('228');
    // A share tally is grouped, not `dec()`-formatted — and still a string.
    expect(typeof parsed.volume).toBe('string');
    expect(parsed.volume).not.toBe('41235900');
  });

  it('a wrong-currency quote dashes out rather than rendering the wrong money', () => {
    // The same guard `quoteFigures` applies. A PLN-priced quote under a USD
    // instrument is not a smaller number — it is a different question.
    const parsed = dayStatsSchema.parse(dayStatsFigures(quote({ currency: 'PLN' }), 'USD'));
    expect(parsed).toEqual({
      prevClose: null,
      dayOpen: null,
      dayLow: null,
      dayHigh: null,
      volume: null,
      vwap: null,
    });
  });

  it('an absent field is null, never a fabricated zero', () => {
    const parsed = dayStatsSchema.parse(
      dayStatsFigures(quote({ dayOpen: null, dayVolume: null }), 'USD'),
    );
    expect(parsed.dayOpen).toBeNull();
    expect(parsed.volume).toBeNull();
  });

  it('no quote at all is every cell absent, not a zeroed row', () => {
    expect(dayStatsSchema.parse(dayStatsFigures(undefined, 'USD')).prevClose).toBeNull();
  });
});

describe('the instrument payload carries the fallback price and the stats row', () => {
  const base = {
    instrumentId: '11111111-1111-4111-8111-111111111111',
    symbol: 'AAPL',
    displayName: 'Apple Inc.',
    currency: 'USD',
    exchange: 'NASDAQ',
    owned: true,
    watched: false,
    hasDividends: false,
    position: null,
    price: '231,10 $',
    cachedPrice: null,
    dayPct: null,
    extended: null,
    dayStats: dayStatsFigures(quote(), 'USD'),
    about: {
      description: null,
      marketCap: null,
      employees: null,
      website: null,
      week52: null,
    },
    groups: [],
    transactions: [],
    priceTargets: [],
    targetStatus: null,
  };

  it('parses with a live price and no cached fallback', () => {
    expect(instrumentResponseSchema.parse(base).cachedPrice).toBeNull();
  });

  it('carries the fetch instant with a cached price, so the client can label it', () => {
    const parsed = instrumentResponseSchema.parse({
      ...base,
      price: null,
      cachedPrice: { text: '228,00 $', asOfMs: 1_760_000_000_000 },
    });
    // A FETCH time, never a trade time — the client's wording depends on this
    // being the only instant the payload offers alongside a stale price.
    expect(parsed.cachedPrice?.asOfMs).toBe(1_760_000_000_000);
  });

  it('carries the price targets, waiting and hit alike', () => {
    const parsed = instrumentResponseSchema.parse({
      ...base,
      priceTargets: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          instrumentId: base.instrumentId,
          targetPrice: '250',
          direction: 'up',
          hitAtMs: null,
          createdAtMs: 1_757_000_000_000,
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          instrumentId: base.instrumentId,
          targetPrice: '180',
          direction: 'down',
          hitAtMs: 1_757_000_600_000,
          createdAtMs: 1_756_000_000_000,
        },
      ],
    });
    expect(parsed.priceTargets).toHaveLength(2);
    expect(parsed.priceTargets[0].hitAtMs).toBeNull();
  });

  it('carries the proximity status beside the target rows, and requires the field', () => {
    const parsed = instrumentResponseSchema.parse({
      ...base,
      targetStatus: {
        text: '3,26%',
        sentence: '3,26% below your 190,00 USD line',
        side: 'below',
        near: true,
        hitOnly: false,
      },
    });
    expect(parsed.targetStatus?.sentence).toContain('below your');

    // Required-nullable, like priceTargets: an answer without it is a
    // producer bug, not an old shape.
    const without: Record<string, unknown> = { ...base };
    delete without.targetStatus;
    expect(instrumentResponseSchema.safeParse(without).success).toBe(false);
  });

  it('a payload with no targets still needs the empty list — the field is not optional', () => {
    expect(instrumentResponseSchema.parse(base).priceTargets).toEqual([]);
    const without: Record<string, unknown> = { ...base };
    delete without.priceTargets;
    expect(instrumentResponseSchema.safeParse(without).success).toBe(false);
  });

  it('refuses a payload with no stats row at all', () => {
    const without: Record<string, unknown> = { ...base };
    delete without.dayStats;
    expect(instrumentResponseSchema.safeParse(without).success).toBe(false);
  });

  it('round-trips a fully-null about panel', () => {
    const parsed = instrumentResponseSchema.parse(base);
    expect(parsed.about).toEqual({
      description: null,
      marketCap: null,
      employees: null,
      website: null,
      week52: null,
    });
  });

  it('round-trips a fully-populated about panel', () => {
    const about = {
      description: 'Apple designs and manufactures consumer electronics.',
      marketCap: '3,21T',
      employees: '164\u00a0000',
      website: 'https://www.apple.com',
      week52: {
        low: '164,08\u00a0USD',
        high: '260,10\u00a0USD',
        lowRaw: '164.08',
        highRaw: '260.10',
        currentRaw: '231.10',
      },
    };
    const parsed = instrumentResponseSchema.parse({ ...base, about });
    expect(parsed.about).toEqual(about);
  });
});

describe('settings payload', () => {
  it('carries the three verdicts and nothing resembling a key', () => {
    const parsed = settingsResponseSchema.parse({
      marketData: 'unauthorized',
      lastPriceFetchedAtMs: 1_760_000_000_000,
      recoveryMode: true,
    });
    expect(parsed.marketData).toBe('unauthorized');
    expect(Object.keys(parsed).sort()).toEqual([
      'lastPriceFetchedAtMs',
      'marketData',
      'recoveryMode',
    ]);
  });

  it('a never-written quote cache is null, not epoch zero', () => {
    const parsed = settingsResponseSchema.parse({
      marketData: 'ok',
      lastPriceFetchedAtMs: null,
      recoveryMode: false,
    });
    expect(parsed.lastPriceFetchedAtMs).toBeNull();
  });

  it('rejects a verdict the client has no branch for', () => {
    expect(
      settingsResponseSchema.safeParse({
        marketData: 'degraded',
        lastPriceFetchedAtMs: null,
        recoveryMode: false,
      }).success,
    ).toBe(false);
  });
});
