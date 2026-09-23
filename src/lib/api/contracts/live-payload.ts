import { trendDaysField } from './trend';
import { z } from 'zod';

import {
  directionSchema,
  displayStringSchema,
  epochMsSchema,
  decimalStringSchema,
  uuidSchema,
} from './common';

/**
 * `LivePayload` — the shape `/api/quotes`, `/api/quotes/stream` and the
 * bootstrap endpoint all return — expressed as zod.
 *
 * This is a MIRROR of the interfaces in `src/lib/holdings/live-payload.ts`,
 * which stay the authoring surface for the server. Writing it twice is a
 * deliberate, one-time cost: the interfaces are what the composer is typed
 * against, and this schema is what the Swift client is generated from and
 * what the route tests assert the real payload against. If the two drift,
 * `live-payload-contract.test.ts` fails — which is the whole point of having
 * the second copy.
 *
 * Every money and percent field here is a pre-formatted DISPLAY string
 * (`fmtMoney`/`fmtPct` output), except the two `*Raw` twins, which are
 * unformatted decimal strings for ordering. Neither is ever a number.
 */

export const marketStatusSchema = z.enum([
  'open',
  'closed',
  'early_trading',
  'late_trading',
  'unknown',
]);

/** A signed, pre-formatted figure plus its `directionOf()` token choice. */
export const liveFigureSchema = z.object({
  text: displayStringSchema,
  direction: directionSchema,
});

export const cachedPriceSchema = z.object({
  text: displayStringSchema,
  /** FETCH time, not a trade time — labelled "cached" on the client. */
  asOfMs: epochMsSchema,
});

export const extendedFigureSchema = liveFigureSchema.extend({
  kind: z.enum(['early', 'late']).meta({ title: 'ExtendedSessionKind' }),
  live: z.boolean(),
  endedAtMs: epochMsSchema.nullable(),
});

export const liveHoldingSchema = z.object({
  instrumentId: uuidSchema,
  price: displayStringSchema.nullable(),
  cachedPrice: cachedPriceSchema.nullable(),
  dayPct: liveFigureSchema.nullable(),
  extended: extendedFigureSchema.nullable(),
  unrealizedPLN: displayStringSchema.nullable(),
  unrealizedPct: displayStringSchema,
  direction: directionSchema,
  valuePLN: displayStringSchema.nullable(),
  /** Ordering twin of `valuePLN` — decimal string, never rendered. */
  valuePLNRaw: decimalStringSchema.nullable(),
  /** Ordering twin of `unrealizedPLN` — same contract. */
  unrealizedPLNRaw: decimalStringSchema.nullable(),
});

export const liveMarketSchema = z.object({
  status: marketStatusSchema,
  nextTransitionAtMs: epochMsSchema.nullable(),
  nextTransitionKind: z
    .enum(['open', 'close'])
    .meta({ title: 'MarketTransitionKind' })
    .nullable(),
  pollingResumesAtMs: epochMsSchema.nullable(),
  serverNowMs: epochMsSchema,
});

export const liveSummarySchema = z.object({
  totalValue: displayStringSchema.nullable(),
  dayChange: liveFigureSchema.nullable(),
  totalChange: liveFigureSchema.nullable(),
  /** The percent halves alone, for a renderer with no room for the amount
   *  (the widgets). Same Decimal, same `fmtPct`, same site as `text`. */
  dayChangePct: displayStringSchema.nullable(),
  totalChangePct: displayStringSchema.nullable(),
  /** Open positions the summary could not price — named, never zeroed. */
  excludedSymbols: z.array(z.string()),
  partialDayChange: z.boolean(),
  /**
   * The whole book's five-session strip — the same lights every tile draws,
   * over the summed value (PLN for holdings, USD for options). Optional for
   * the same upgrade-path reason `trendDaysField` documents.
   */
  trend: trendDaysField,
});

export const liveScopeSchema = z.object({
  id: uuidSchema,
  summary: liveSummarySchema,
  holdings: z.array(liveHoldingSchema),
});

export const livePayloadSchema = z.object({
  market: liveMarketSchema,
  summary: liveSummarySchema,
  holdings: z.array(liveHoldingSchema),
  /** One entry per portfolio, in display order; `[]` when none composed. */
  scopes: z.array(liveScopeSchema),
  hasPollableSymbols: z.boolean(),
});

export type LivePayloadContract = z.output<typeof livePayloadSchema>;
