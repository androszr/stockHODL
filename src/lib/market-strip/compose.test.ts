import { describe, expect, it } from 'vitest';

import type { ChartPoint } from '@/lib/charts/series';
import type { HoldingQuote } from '@/lib/holdings/live-payload';
import type { MarketSessionInfo } from '@/lib/market-data/provider';
import { dec, pctChange } from '@/lib/money';

import { composeMarketStrip, indexProxyFor, INDEX_PROXIES, INDEX_PROXY_SYMBOLS } from './compose';
import { NULL_FX_FIGURES, type FxFigures } from './fx';

/**
 * The strip's composer, which is the only place a proxy fund's quote becomes
 * an index tile. Two things it must never do: reorder or drop a tile (the row
 * would reflow around a vendor hiccup), and show a figure without the
 * `proxySymbol` that says which fund produced it.
 */

function quote(overrides: Partial<HoldingQuote> = {}): HoldingQuote {
  return {
    price: '645.32',
    currency: 'USD',
    prevClose: '639.95',
    dayChangeAmt: dec('645.32').minus(dec('639.95')).toString(),
    dayChangePct: pctChange(dec('639.95'), dec('645.32'))!.toString(),
    extendedChangePct: null,
    extendedKind: null,
    extendedEndedAtMs: null,
    extendedLive: false,
    ...overrides,
  };
}

const MARKET: MarketSessionInfo = {
  status: 'open',
  nextTransitionAtMs: 1_756_000_000_000,
  nextTransitionKind: 'close',
  pollingResumesAtMs: null,
};

const SPARK: ChartPoint[] = [
  { t: 1_755_950_100_000, v: '640.10' },
  { t: 1_755_950_400_000, v: '645.32' },
];

function allQuotes(): Map<string, HoldingQuote> {
  return new Map(INDEX_PROXY_SYMBOLS.map((symbol) => [symbol, quote()]));
}

const FX: FxFigures = {
  last: '3,7955',
  dayPct: { text: '+0,12%', direction: 'gain' },
  spark: [
    { t: 1_755_950_100_000, v: '3.7900' },
    { t: 1_755_950_400_000, v: '3.7955' },
  ],
};

/** The old three-argument call, for the cases that are about the index tiles. */
function compose(
  quotes: Map<string, HoldingQuote>,
  sparks: Map<string, ChartPoint[]>,
  market: MarketSessionInfo = MARKET,
) {
  return composeMarketStrip(quotes, sparks, market, FX);
}

describe('composeMarketStrip', () => {
  it('answers exactly the three proxies, in the fixed order', () => {
    const payload = compose(allQuotes(), new Map(), MARKET);

    expect(payload.tiles.map((tile) => tile.proxySymbol)).toEqual(['SPY', 'QQQ', 'DIA']);
    expect(payload.tiles.map((tile) => tile.indexName)).toEqual(['S&P 500', 'Nasdaq', 'Dow']);
    expect(INDEX_PROXIES).toHaveLength(3);
  });

  it('never renders a figure without naming the fund it came from', () => {
    const payload = compose(allQuotes(), new Map(), MARKET);

    for (const tile of payload.tiles) {
      expect(tile.proxySymbol).toMatch(/^[A-Z]+$/);
      expect(tile.indexName.length).toBeGreaterThan(0);
    }
  });

  it('formats the headline price and the day percent from the quote', () => {
    const payload = compose(allQuotes(), new Map(), MARKET);
    const spy = payload.tiles[0];

    expect(spy.last).toContain('645,32');
    expect(spy.dayPct?.text.startsWith('+')).toBe(true);
    expect(spy.dayPct?.direction).toBe('gain');
  });

  it('signs a falling day and calls it a loss', () => {
    const falling = quote({
      price: '630.00',
      dayChangeAmt: dec('630.00').minus(dec('639.95')).toString(),
      dayChangePct: pctChange(dec('639.95'), dec('630.00'))!.toString(),
    });
    const payload = compose(new Map([['SPY', falling]]), new Map(), MARKET);

    expect(payload.tiles[0].dayPct?.text.startsWith('-')).toBe(true);
    expect(payload.tiles[0].dayPct?.direction).toBe('loss');
  });

  it('nulls a missing quote without disturbing its neighbours', () => {
    const payload = compose(
      new Map([
        ['SPY', quote()],
        ['DIA', quote()],
      ]),
      new Map([['SPY', SPARK]]),
      MARKET,
    );

    expect(payload.tiles[1].proxySymbol).toBe('QQQ');
    expect(payload.tiles[1].last).toBeNull();
    expect(payload.tiles[1].dayPct).toBeNull();
    expect(payload.tiles[1].spark).toEqual([]);
    expect(payload.tiles[0].last).not.toBeNull();
    expect(payload.tiles[2].last).not.toBeNull();
  });

  it('refuses a non-USD quote through the quoteFigures currency guard', () => {
    const payload = compose(
      new Map([['SPY', quote({ currency: 'PLN' })]]),
      new Map(),
      MARKET,
    );

    expect(payload.tiles[0].last).toBeNull();
    expect(payload.tiles[0].dayPct).toBeNull();
  });

  it('carries each proxy its own spark, oldest first', () => {
    const payload = compose(allQuotes(), new Map([['QQQ', SPARK]]), MARKET);

    expect(payload.tiles[1].spark).toEqual(SPARK);
    expect(payload.tiles[0].spark).toEqual([]);
    expect(payload.tiles[1].spark[0].t).toBeLessThan(payload.tiles[1].spark[1].t);
  });

  it('stamps the server clock onto the market block and keeps the poll gate', () => {
    const before = Date.now();
    const payload = compose(
      allQuotes(),
      new Map(),
      { ...MARKET, status: 'closed', pollingResumesAtMs: 1_756_100_000_000 },
    );

    expect(payload.market.serverNowMs).toBeGreaterThanOrEqual(before);
    expect(payload.market.pollingResumesAtMs).toBe(1_756_100_000_000);
    expect(payload.market.status).toBe('closed');
  });

  // MARK: the fourth tile (2026-09-20)

  it('stamps every index tile with its key, equal to the proxy symbol', () => {
    const payload = compose(allQuotes(), new Map());

    expect(payload.tiles.map((tile) => tile.key)).toEqual(['SPY', 'QQQ', 'DIA']);
    for (const tile of payload.tiles) expect(tile.key).toBe(tile.proxySymbol);
    expect(indexProxyFor('QQQ')?.indexName).toBe('Nasdaq');
    expect(indexProxyFor('USDPLN')).toBeNull();
  });

  it('passes the fx figures through as the USD/PLN tile, labelled', () => {
    const payload = compose(allQuotes(), new Map());

    expect(payload.fx.key).toBe('USDPLN');
    expect(payload.fx.pairLabel).toBe('USD/PLN');
    expect(payload.fx.caption).toBe('PLN per 1 USD');
    expect(payload.fx.last).toBe('3,7955');
    expect(payload.fx.dayPct).toEqual({ text: '+0,12%', direction: 'gain' });
    expect(payload.fx.spark).toEqual(FX.spark);
    // A copy, never the caller's array.
    expect(payload.fx.spark).not.toBe(FX.spark);
  });

  it('a degraded fx tile does not disturb the three index tiles', () => {
    const payload = composeMarketStrip(allQuotes(), new Map([['SPY', SPARK]]), MARKET, {
      ...NULL_FX_FIGURES,
      spark: [],
    });

    expect(payload.fx.last).toBeNull();
    expect(payload.fx.dayPct).toBeNull();
    expect(payload.fx.spark).toEqual([]);
    // Still labelled — the tile says what it is about even with no number.
    expect(payload.fx.pairLabel).toBe('USD/PLN');
    expect(payload.tiles).toHaveLength(3);
    expect(payload.tiles[0].last).not.toBeNull();
    expect(payload.tiles[0].spark).toEqual(SPARK);
    // The snapshot batch stays three: the currency never enters it.
    expect(INDEX_PROXY_SYMBOLS).toEqual(['SPY', 'QQQ', 'DIA']);
  });
});
