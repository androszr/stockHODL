import { z } from 'zod';

import { displayStringSchema } from './common';
import { liveFigureSchema, liveMarketSchema } from './live-payload';
import { chartPointSchema } from './series';
import { trendDaysField } from './trend';

/**
 * The Dashboard's market index strip — three tiles across the top of the
 * Dashboard tab, the Yahoo-Finance row.
 *
 * **The disclosure IS the contract.** The real index feeds (`I:SPX`, `I:NDX`,
 * `I:DJI`) are NOT_ENTITLED on the Massive plan — verified and permanent — so
 * each tile follows the fund that tracks its index and says so. `indexName`
 * is what the tile is ABOUT and `proxySymbol` is where the number came from;
 * a renderer that shows one without the other is passing a fund's price off
 * as an index level. Both fields are required and neither is nullable, so
 * there is no decoded state in which the caption can be absent.
 *
 * Its own payload, deliberately NOT a field on `livePayloadSchema`: that one
 * is tick-shaped, re-sent on every 10 s poll and re-baselined on every SSE
 * reconnect, while a day-session sparkline is series-shaped and changes once
 * per five-minute bar. Riding it would also widen the holdings vendor batch
 * and the socket subscription with three symbols nobody holds — the same
 * refusal the watchlist's parallel delivery is built on.
 *
 * Shared shapes are IMPORTED, never restated: the codegen puts every export
 * through one zod registry, so `spark` decodes as the existing `ChartPoint`
 * and the figures as `LiveFigure` rather than as forked twins.
 */

/**
 * The CLOSED set of tiles the strip can ever carry, and the only keys the
 * per-tile series door accepts. Three ETF proxies plus the one currency
 * pair; there is no way to widen it from a request. `.meta({ title })` is
 * what makes quicktype emit a named Swift enum rather than an inline string
 * union, so `Route.marketDetail(MarketTileKey)` can be typed on the phone.
 */
export const MARKET_TILE_KEYS = ['SPY', 'QQQ', 'DIA', 'USDPLN'] as const;

export type MarketTileKey = (typeof MARKET_TILE_KEYS)[number];

export const marketTileKeySchema = z.enum(MARKET_TILE_KEYS).meta({ title: 'MarketTileKey' });

/**
 * The path parameter of `/api/mobile/v1/market-strip/series/[key]`: trimmed,
 * uppercased, then piped through the closed enum, so `usdpln` resolves and
 * `AAPL` or `C:USDPLN` do not. Request-only — listed in the codegen's
 * `REQUEST_ONLY`, never decoded on the phone.
 */
export const marketSeriesKeyParamSchema = z.string().trim().toUpperCase().pipe(marketTileKeySchema);

export const indexTileSchema = z.object({
  /** Which tile this is — the value the detail screen is routed on. Always
   *  equal to `proxySymbol` for an index tile. */
  key: marketTileKeySchema,
  /** What the tile is about — 'S&P 500', 'Nasdaq', 'Dow'. */
  indexName: displayStringSchema,
  /** Where the number actually came from — 'SPY', 'QQQ', 'DIA'. */
  proxySymbol: z.string(),
  /** Pre-formatted headline price, status-aware; null when unpriceable. */
  last: displayStringSchema.nullable(),
  /** The day's move, from the same coherent triple as `last`. */
  dayPct: liveFigureSchema.nullable(),
  /** Five-session strip on the proxy's daily closes — the tiles' lights. */
  trend: trendDaysField,
  /**
   * The day's regular session, oldest first — five-minute bars. Empty when
   * the vendor answered nothing; an empty spark draws no line rather than a
   * flat one, and never blocks the tile's figures.
   */
  spark: z.array(chartPointSchema),
});

export type IndexTileContract = z.output<typeof indexTileSchema>;

/**
 * The USD/PLN tile (2026-09-20). Its figures come from forex AGGREGATES, not
 * a snapshot — the vendor's snapshot endpoint is NOT_ENTITLED for currency
 * pairs on this plan — so `last` is the newest minute bar's close and
 * `dayPct` is measured from the last daily close strictly before the tip's
 * UTC day. `caption` says what the figure means ("PLN per 1 USD") the way an
 * index tile's `proxySymbol` says where its number came from: the tile is
 * never a bare number.
 */
export const currencyTileSchema = z.object({
  key: marketTileKeySchema,
  /** 'USD/PLN'. */
  pairLabel: displayStringSchema,
  /** 'PLN per 1 USD' — the unit of the figure, rendered under the title. */
  caption: displayStringSchema,
  /** Four-decimal pre-formatted rate; null when the vendor answered nothing. */
  last: displayStringSchema.nullable(),
  /** The UTC-day move, derived from the same bars as `last`. */
  dayPct: liveFigureSchema.nullable(),
  /** Five-UTC-day strip on the pair's daily closes, graded on the FX bands. */
  trend: trendDaysField,
  /** The current UTC day's minute bars, oldest first; empty when unavailable. */
  spark: z.array(chartPointSchema),
});

export type CurrencyTileContract = z.output<typeof currencyTileSchema>;

export const marketStripPayloadSchema = z.object({
  /** Always the three proxies, in fixed order — never client-selectable. */
  tiles: z.array(indexTileSchema),
  /** The USD/PLN tile. A NEW key on the response (2026-09-20): an installed
   *  build that predates it decodes the payload unchanged and simply keeps
   *  drawing three tiles. */
  fx: currencyTileSchema,
  /** The same market block the options payload carries: the poll gate reads it. */
  market: liveMarketSchema,
});

export type MarketStripPayloadContract = z.output<typeof marketStripPayloadSchema>;
