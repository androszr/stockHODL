import { z } from 'zod';

import { currencySchema, displayStringSchema, uuidSchema } from './common';
import { livePayloadSchema } from './live-payload';
import { portfolioSchema } from './portfolios';
import { trendDaysField } from './trend';
import { watchedItemSchema } from './watchlist';

/**
 * ONE call that replaces everything the Holdings Server Components compose on
 * a cold start: portfolios, the per-mutation half of the holdings view, the
 * watchlist, and the live payload.
 *
 * Why one call and not four: on a phone the round trip dominates, and the
 * four pieces are useless apart — the screen cannot paint a card without both
 * its static half and its live half. This is also what lets the client write
 * a single snapshot to the App Group container (plan A.7) and repaint from it
 * instantly on the next launch.
 *
 * The split inside mirrors `HoldingsView`: `staticHoldings`/`scopes` change
 * only on a mutation, `live` changes on every poll. The client keeps the
 * first and swaps the second — the same discipline the web client already
 * follows.
 */

/** The per-mutation half of one holding — mirrors `StaticHolding`. */
export const staticHoldingSchema = z.object({
  instrumentId: uuidSchema,
  symbol: z.string(),
  displayName: z.string(),
  currency: currencySchema,
  quantity: displayStringSchema,
  /** Null when quantity is zero (oversold-at-zero rows). */
  avgCost: displayStringSchema.nullable(),
  costBasisPLN: displayStringSchema,
  oversold: z.boolean(),
  /**
   * The five-day trend strip. It rides the STATIC half deliberately: it
   * changes once a day, while `LivePayload` is re-sent on every SSE tick —
   * and this is the half the client keeps across ticks and writes to its
   * on-disk snapshot, so the strip survives a cold start offline for free.
   */
  trend: trendDaysField,
});

/** One portfolio scope's static half — mirrors `StaticScope`. */
export const staticScopeSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  txCount: z.number().int(),
  staticHoldings: z.array(staticHoldingSchema),
});

export const bootstrapResponseSchema = z.object({
  portfolios: z.array(portfolioSchema),
  staticHoldings: z.array(staticHoldingSchema),
  scopes: z.array(staticScopeSchema),
  watchlist: z.array(watchedItemSchema),
  live: livePayloadSchema,
});

export type BootstrapResponseContract = z.output<typeof bootstrapResponseSchema>;
