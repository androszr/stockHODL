import { z } from 'zod';

import { watchlistAddSchema } from '@/lib/validation';

import { currencySchema, uuidSchema } from './common';
import {
  extendedFigureSchema,
  liveFigureSchema,
  liveMarketSchema,
} from './live-payload';
import { targetStatusSchema } from './price-targets';
import { trendDaysField } from './trend';

/**
 * Watchlist contracts. The write side is `watchlistAddSchema` from
 * `src/lib/validation.ts` verbatim — the same trims, bounds and closed
 * currency list the web add-flow uses, because both paths mint an instrument
 * through `resolveOrCreateInstrument` and a typo'd code would bind a symbol
 * permanently either way.
 */

export const watchlistAddRequestSchema = watchlistAddSchema;

/**
 * One watched row's static identity. The quotes arrive separately, from
 * `/api/mobile/v1/watchlist/quotes` (+ `/stream`) — the mobile twins of
 * `/api/quotes/watchlist`, which the phone cannot reach because `src/proxy.ts`
 * is a cookie gate excluding only `/api/mobile/`.
 */
export const watchedItemSchema = z.object({
  instrumentId: uuidSchema,
  symbol: z.string(),
  displayName: z.string(),
  currency: currencySchema,
  /**
   * The five-day trend strip, carried here as well as on `staticHolding` and
   * NOT only on the bootstrap: `WatchlistStore.refresh()` fetches
   * `/api/mobile/v1/watchlist` on its own and never reads the bootstrap, so a
   * strip hung off the holdings half alone would never reach a watched tile.
   */
  trend: trendDaysField,
});

export type WatchedItemContract = z.output<typeof watchedItemSchema>;

export const watchlistResponseSchema = z.object({
  /** Insertion-ordered, oldest watch first — the only ordering there is. */
  items: z.array(watchedItemSchema),
});

/**
 * One tile's LIVE half — figures only, matched to a static row by
 * `instrumentId`. The identity ships with the list, not with every tick.
 *
 * The three figure fields are the same objects a holding carries, reused
 * rather than restated: `quoteFigures` composes both, so a divergence here
 * would be a lie about a shared function.
 */
/**
 * Which section of the Watchlist an item files under
 * (plans/2026-09-15-watchlist-target-proximity.md): `near` = within 5%
 * (inclusive) of a waiting target line, `set` = has a waiting line but not
 * near (or no usable price to measure with), `none` = no lines, or only hit
 * ones. Named so the codegen registers one `TargetGroup` type.
 */
export const targetGroupSchema = z.enum(['near', 'set', 'none']);

export type TargetGroupContract = z.output<typeof targetGroupSchema>;

export const liveWatchItemSchema = z.object({
  instrumentId: uuidSchema,
  price: z.string().nullable(),
  dayPct: liveFigureSchema.nullable(),
  extended: extendedFigureSchema.nullable(),
  /** The section this item files under — the client renders the server's
   *  verdict, never re-derives it. */
  targetGroup: targetGroupSchema,
  /** The proximity readout for the tile marker; null when there is nothing
   *  to mark (no lines at all). */
  target: targetStatusSchema.nullable(),
});

/**
 * A PARALLEL payload to `LivePayload`, deliberately not a widened one:
 * watched symbols never enter the Holdings walk, so the Holdings payload and
 * its vendor batch stay byte-identical whatever is on the watchlist.
 *
 * `items` is SERVER-SORTED since the target-proximity feature: group order
 * `near` → `set` → `none`, ascending distance within `near`/`set` (unpriced
 * `set` items after priced ones), insertion order inside `none` and as every
 * tie-break. The stream recomposes per tick, so the list and its live
 * updates agree about the order by construction.
 */
export const watchlistPayloadSchema = z.object({
  market: liveMarketSchema,
  items: z.array(liveWatchItemSchema),
  /** Structural poll-gate verdict — same contract as `LivePayload`'s. */
  hasPollableSymbols: z.boolean(),
});

export type WatchlistPayloadContract = z.output<typeof watchlistPayloadSchema>;
