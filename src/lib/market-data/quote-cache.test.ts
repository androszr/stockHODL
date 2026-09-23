import { describe, expect, it, vi } from 'vitest';

import type { Quote } from './provider';

/**
 * The PURE halves of the quote cache — the throttle decision and the two row
 * mappings — with the framework boundaries stubbed only so the module can be
 * imported (the price-history.test.ts pattern: no Drizzle chain mocking, the
 * IO stays real code paths exercised elsewhere).
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: {}, latestQuotes: {} }));

import {
  persistThrottleKey,
  QUOTE_CACHE_WRITE_INTERVAL_MS,
  shouldPersist,
  toCachedQuote,
  toLatestQuoteRows,
} from './quote-cache';

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: 'AAPL',
    price: '231.59',
    prevClose: '229.35',
    asOf: new Date('2026-08-14T20:00:00Z'),
    asOfSource: 'trade',
    delaySeconds: 900,
    marketStatus: 'closed',
    dayChangeAmt: '2.24',
    dayChangePct: '0.98',
    dayOpen: '229.9',
    dayHigh: '232.5',
    dayLow: '229.1',
    dayVolume: 51234567,
    vwap: '231.02',
    extendedChangeAmt: null,
    extendedChangePct: null,
    extendedKind: null,
    extendedEndedAtMs: null,
    extendedLive: false,
    source: 'massive',
    ...overrides,
  };
}

describe('shouldPersist — the 60 s write throttle', () => {
  it('a cold start (lastAt 0) writes immediately — exactly when the cache matters', () => {
    expect(shouldPersist(1_000, 0)).toBe(true);
  });

  it('inside the window: no write; at/after the boundary: write', () => {
    const last = 1_000_000;
    expect(shouldPersist(last + QUOTE_CACHE_WRITE_INTERVAL_MS - 1, last)).toBe(false);
    expect(shouldPersist(last + QUOTE_CACHE_WRITE_INTERVAL_MS, last)).toBe(true);
  });
});

describe('persistThrottleKey — per-surface windows, not one global clock', () => {
  it('is order-insensitive and deduped — one surface, one key', () => {
    expect(persistThrottleKey(['i2', 'i1', 'i2'])).toBe(persistThrottleKey(['i1', 'i2']));
  });

  it('keys off the REQUESTED set, so a partial vendor answer reuses the same window — the regression: a subset-derived key looks cold on every flapping poll and writes each tick', () => {
    const requested = ['i1', 'i2', 'i3'];
    // Two consecutive polls where different symbols happen to answer.
    expect(persistThrottleKey(requested)).toBe(persistThrottleKey(requested));
    // ...and that key is NOT what either successful subset would produce.
    expect(persistThrottleKey(requested)).not.toBe(persistThrottleKey(['i1']));
    expect(persistThrottleKey(requested)).not.toBe(persistThrottleKey(['i2', 'i3']));
  });

  it('distinct instrument-id sets get distinct keys — the regression: a polling Holdings surface must not re-arm the window for a watched-only ticker page', () => {
    const holdingsKey = persistThrottleKey(['i1', 'i2']);
    const watchedTickerKey = persistThrottleKey(['i3']);
    const watchlistKey = persistThrottleKey(['i3', 'i4']);
    expect(holdingsKey).not.toBe(watchedTickerKey);
    expect(watchedTickerKey).not.toBe(watchlistKey);
    // A never-seen key starts at 0 — a one-shot page load writes immediately
    // regardless of what any other surface just persisted.
    expect(shouldPersist(Date.now(), 0)).toBe(true);
  });
});

describe('toLatestQuoteRows — quotes → insert rows', () => {
  const NOW = new Date('2026-08-16T12:00:00Z');

  it('maps a full quote onto the NOT NULL row shape, numeric(20,8) serialized', () => {
    const [row] = toLatestQuoteRows([{ instrumentId: 'i1', quote: quote() }], NOW);
    expect(row).toEqual({
      instrumentId: 'i1',
      price: '231.59000000',
      prevClose: '229.35000000',
      currency: 'USD',
      marketState: 'closed',
      quoteDelayS: 900,
      source: 'massive',
      fetchedAt: NOW,
    });
  });

  it('SKIPS a quote with a null prevClose — the column is NOT NULL, and a cache row is optional by nature', () => {
    const rows = toLatestQuoteRows(
      [
        { instrumentId: 'i1', quote: quote({ prevClose: null }) },
        { instrumentId: 'i2', quote: quote({ symbol: 'MSFT' }) },
      ],
      NOW,
    );
    expect(rows.map((r) => r.instrumentId)).toEqual(['i2']);
  });
});

describe('toCachedQuote — stored row → display entry', () => {
  it('re-normalises numeric(20,8) padding through dec() and trims char(3)', () => {
    const entry = toCachedQuote({
      price: '231.59000000',
      currency: 'USD',
      fetchedAt: new Date(1_755_340_800_000),
    });
    expect(entry).toEqual({ price: '231.59', currency: 'USD', fetchedAtMs: 1_755_340_800_000 });
  });
});
