import { z } from 'zod';

import { CHART_RANGES } from '@/lib/charts/ranges';

import { decimalStringSchema, epochMsSchema, isoDateSchema } from './common';

/**
 * Chart-series contracts — the zod mirror of `SeriesPayload` from
 * `src/lib/charts/series.ts`.
 *
 * The optional fields (`p`, `r`, `o`/`h`/`l`) are optional on the wire too:
 * the common case serializes without them, which is what keeps a 5Y daily
 * payload small. Swift decodes them as optionals.
 *
 * `t` is epoch ms — a timestamp, not money. Every VALUE is a decimal string;
 * the only float in the whole chart path is the one the renderer produces
 * from these strings, and on iOS that conversion is confined to
 * `PlotPoints.swift` (plan A.4).
 */

export const chartRangeSchema = z.enum(CHART_RANGES);

export const chartPointSchema = z.object({
  t: epochMsSchema,
  v: decimalStringSchema,
  /** Extended-hours marker; absent = regular session. 1D series only. */
  p: z.enum(['pre', 'post']).meta({ title: 'SessionMarker' }).optional(),
  /** Simple return vs open cost basis, decimal-string percent. Portfolio only. */
  r: decimalStringSchema.optional(),
  /** OHLC for the candlestick view. All three or none. Instrument only. */
  o: decimalStringSchema.optional(),
  h: decimalStringSchema.optional(),
  l: decimalStringSchema.optional(),
});

export const seriesPayloadSchema = z.object({
  points: z.array(chartPointSchema),
  /** Days summed from an incomplete instrument set — a count, not money. */
  partialDays: z.number().int(),
  /** Symbols the series could not include at all — named, never zeroed in. */
  excludedSymbols: z.array(z.string()),
  anchorDate: isoDateSchema.nullable(),
  /**
   * The date from which the plotted values are the app's own model estimates
   * rather than real traded prices (2026-08-20). OPTIONAL on the wire like
   * `p`/`r`: only the two options series ever set it, so every other payload
   * serializes exactly as before and Swift decodes it as an optional.
   */
  estimatedFrom: isoDateSchema.optional(),
});

export type SeriesPayloadContract = z.output<typeof seriesPayloadSchema>;

export const portfolioSeriesQuerySchema = z.object({
  range: chartRangeSchema,
  /**
   * Optional scope. A foreign, malformed or deleted id resolves to the
   * all-portfolios series through `resolvePortfolioScope` — never a 404,
   * never an error, and nothing enumerable. Same rule as the web.
   */
  portfolioId: z.string().optional(),
});

/**
 * The price series is addressed by SYMBOL in the path
 * (`/series/price/AAPL?range=1D`), because that is what the client already
 * holds on the instrument screen. The symbol resolves to an instrument id
 * server-side, scoped to the caller's own transactions or watchlist — a
 * foreign or unknown ticker gets the empty payload, exactly as the Server
 * Action does with a foreign uuid. Nothing is enumerable either way.
 */
export const priceSeriesQuerySchema = z.object({
  range: chartRangeSchema,
});

/** Path-parameter shape, validated with the same bounds as a symbol input. */
export const symbolParamSchema = z.string().trim().toUpperCase().min(1).max(20);
