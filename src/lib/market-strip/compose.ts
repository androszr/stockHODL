import type {
  CurrencyTileContract,
  IndexTileContract,
  MarketStripPayloadContract,
  MarketTileKey,
} from '@/lib/api/contracts/market-strip';
import type { TrendSlot } from '@/lib/trend/day-trend';
import type { ChartPoint } from '@/lib/charts/series';
import { quoteFigures, type HoldingQuote, type LiveMarket } from '@/lib/holdings/live-payload';
import type { MarketSessionInfo } from '@/lib/market-data/provider';

import { FX_CAPTION, FX_PAIR_LABEL, type FxFigures } from './fx';

/**
 * The Dashboard index strip's payload composition — pure and isomorphic like
 * `live-payload.ts`: no `server-only`, no DB, no fetch. Decimal work happens
 * inside `quoteFigures` (via `src/lib/money.ts`); this module does no
 * arithmetic of its own, and no amount is ever coerced to a float here — the
 * non-negotiable the preflight greps this directory for.
 *
 * `INDEX_PROXIES` is the whole symbol set, server-side and constant. There is
 * no parameter that could widen it. That is what keeps the vendor's real
 * index feeds — verified NOT_ENTITLED on this plan, permanently — beyond
 * reach by construction, and what stops the route being an open quote proxy
 * for whoever holds a token.
 */

export interface IndexProxy {
  /** The tile's identity on the wire and in the phone's route. Equal to
   *  `proxySymbol` for every index tile, typed against the closed enum. */
  key: MarketTileKey;
  /** The index the tile is about. */
  indexName: string;
  /** The ETF whose price the tile actually shows, and names. */
  proxySymbol: string;
  displayName: string;
  exchange: string;
}

/**
 * Fixed order, fixed membership. 'Nasdaq' over QQQ is honest-by-labelling:
 * QQQ tracks the Nasdaq-100 rather than the Composite, and the `via QQQ`
 * caption is the disclosure register that says which number is on screen.
 */
export const INDEX_PROXIES: readonly IndexProxy[] = [
  {
    key: 'SPY',
    indexName: 'S&P 500',
    proxySymbol: 'SPY',
    displayName: 'SPDR S&P 500 ETF Trust',
    exchange: 'NYSE Arca',
  },
  {
    key: 'QQQ',
    indexName: 'Nasdaq',
    proxySymbol: 'QQQ',
    displayName: 'Invesco QQQ Trust',
    exchange: 'NASDAQ',
  },
  {
    key: 'DIA',
    indexName: 'Dow',
    proxySymbol: 'DIA',
    displayName: 'SPDR Dow Jones Industrial Average ETF Trust',
    exchange: 'NYSE Arca',
  },
] as const;

/** Every symbol the strip's SNAPSHOT batch may ever ask the vendor about.
 *  Exactly three — the currency pair is NOT here: its snapshot is
 *  NOT_ENTITLED and its figures come from bars (`fx-load.ts`). */
export const INDEX_PROXY_SYMBOLS: readonly string[] = INDEX_PROXIES.map((p) => p.proxySymbol);

/** The index tile a key names, or null for the currency key. */
export function indexProxyFor(key: MarketTileKey): IndexProxy | null {
  return INDEX_PROXIES.find((proxy) => proxy.key === key) ?? null;
}

/**
 * Quotes + spark series + market status + the FX figures → the strip payload.
 *
 * Best-effort per tile by construction: a symbol the vendor could not price
 * yields `last: null`, `dayPct: null` and an empty spark while its neighbours
 * render normally — three tiles always come back, in the order above, so the
 * row never reflows around a vendor hiccup. The currency guard inside
 * `quoteFigures` refuses a non-USD quote, which is the same guard the
 * holdings cards apply.
 *
 * The FX tile is a fourth, separately-sourced figure: `fx` is the pure output
 * of `composeFxFigures` (bars, not a quote), passed through here with its
 * labels attached. A degraded fx (all-null figures) still yields a tile —
 * the row keeps four slots and the currency slot says "—", exactly as an
 * unpriced index tile does.
 */
export function composeMarketStrip(
  quotes: ReadonlyMap<string, HoldingQuote>,
  sparkBySymbol: ReadonlyMap<string, readonly ChartPoint[]>,
  market: MarketSessionInfo,
  fx: FxFigures,
  /** Proxy symbol → its strip; absent entries render no lights. */
  trendBySymbol: ReadonlyMap<string, TrendSlot[]> = new Map(),
): MarketStripPayloadContract {
  const tiles: IndexTileContract[] = INDEX_PROXIES.map((proxy) => {
    const figures = quoteFigures(quotes.get(proxy.proxySymbol), 'USD');
    return {
      key: proxy.key,
      indexName: proxy.indexName,
      proxySymbol: proxy.proxySymbol,
      last: figures.price,
      dayPct: figures.dayPct,
      trend: trendBySymbol.get(proxy.proxySymbol),
      spark: [...(sparkBySymbol.get(proxy.proxySymbol) ?? [])],
    };
  });

  const fxTile: CurrencyTileContract = {
    key: 'USDPLN',
    pairLabel: FX_PAIR_LABEL,
    caption: FX_CAPTION,
    last: fx.last,
    dayPct: fx.dayPct,
    trend: fx.trend,
    spark: [...fx.spark],
  };

  const liveMarket: LiveMarket = { ...market, serverNowMs: Date.now() };
  return { tiles, fx: fxTile, market: liveMarket };
}
