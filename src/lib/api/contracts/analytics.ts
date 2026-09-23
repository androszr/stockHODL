import { z } from 'zod';

import {
  decimalStringSchema,
  directionSchema,
  displayStringSchema,
  isoDateSchema,
  uuidSchema,
} from './common';
import { chartPointSchema } from './series';

/**
 * Analytics — the phone's read of `/analytics`.
 *
 * The web screen is fully server-rendered and has no REST route of its own
 * (see the comment on `src/app/(app)/analytics/page.tsx`). This payload is
 * the same walk, `getAnalyticsView`, serialized so a native client has
 * something to call. Every figure is a PRE-FORMATTED STRING: XIRR, TWRR,
 * the PLN tiles, the allocation percents. The phone must never re-derive a
 * rate or re-sum a slice, because two folds of the same rows are two
 * chances to disagree about what the portfolio returned.
 *
 * `share` is the one decimal string that is geometry, not a label — the
 * stacked bar's widths. It is converted at the render boundary the same way
 * a chart point's `v` is, and never formatted, never subtracted, never fed
 * back into arithmetic.
 *
 * `?p=` is a FILTER, not authorization. `getAnalyticsView` runs it through
 * `resolvePortfolioScope`: a malformed, foreign or deleted id degrades to
 * All rather than erroring, so the parameter cannot enumerate portfolios.
 */

export const analyticsMetricSchema = z
  .object({
    /** Formatted percent, or '—' when refused. */
    value: z.string(),
    direction: directionSchema,
    /** A sentence explaining a refusal; null when there is a figure. */
    note: z.string().nullable(),
  })
  .meta({ title: 'AnalyticsMetric' });

export type AnalyticsMetricContract = z.output<typeof analyticsMetricSchema>;

export const allocationSliceSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    /** Formatted PLN amount. */
    value: displayStringSchema,
    /** Formatted percent, or '—'. */
    pct: z.string(),
    /** Plotted share of the total, 0–100, as a decimal STRING (geometry). */
    share: decimalStringSchema,
    /** `var(--color-cat-*)` — a token name, never a colour literal. */
    colorVar: z.string(),
  })
  .meta({ title: 'AllocationSlice' });

export type AllocationSliceContract = z.output<typeof allocationSliceSchema>;

/**
 * All four folds travel together so switching a dimension on the phone costs
 * zero requests — the same reason the web page ships them in one payload.
 */
export const analyticsBreakdownSchema = z
  .object({
    ticker: z.array(allocationSliceSchema),
    portfolio: z.array(allocationSliceSchema),
    currency: z.array(allocationSliceSchema),
    sector: z.array(allocationSliceSchema),
  })
  .meta({ title: 'AnalyticsBreakdown' });

export type AnalyticsBreakdownContract = z.output<typeof analyticsBreakdownSchema>;

/**
 * The biggest position and the HHI score, folded server-side from the SAME
 * ticker slices `breakdown` carries — every field pre-formatted, nothing for
 * the phone to derive. Nullable on the response: a scope where nothing can
 * be priced refuses with null rather than fabricating a zero score.
 */
export const analyticsConcentrationSchema = z
  .object({
    /** The largest position's ticker. */
    topSymbol: z.string(),
    /** Its share of the priced total — formatted percent, e.g. '+40,00%'. */
    topShare: z.string(),
    /** HHI scaled 0–100 as an integer string; 100 = one holding. */
    score: z.string(),
  })
  .meta({ title: 'AnalyticsConcentration' });

/**
 * One holding's line on the target-drift card. Every field is a
 * PRE-FORMATTED string: the phone does no arithmetic on a share or an
 * amount, so the card and the breakdown above it can never disagree.
 *
 * `target` is null for a held stock with NO target — never `'0,00%'`, which
 * would read as a standing order to sell the whole position. `drift` is a
 * percentage-POINT delta ('+10,00 pp'), and `amount` is always positive with
 * `action` carrying the direction.
 */
export const analyticsTargetDriftRowSchema = z
  .object({
    instrumentId: uuidSchema,
    symbol: z.string(),
    /** Formatted percent, or null when this holding has no target. */
    target: z.string().nullable(),
    /** Formatted percent, or '—' when nothing in the scope is priced. */
    actual: z.string(),
    /** Signed percentage-POINT delta, e.g. '+10,00 pp'; null without both sides. */
    drift: z.string().nullable(),
    /** Formatted PLN to trade, always positive. */
    amount: z.string().nullable(),
    action: z.enum(['buy', 'sell']).nullable(),
  })
  .meta({ title: 'AnalyticsTargetDriftRow' });

export const analyticsTargetDriftSchema = z
  .object({
    rows: z.array(analyticsTargetDriftRowSchema),
    /** One sentence iff the targets do not add up to 100%; else null. */
    sumNote: z.string().nullable(),
  })
  .meta({ title: 'AnalyticsTargetDrift' });

export const analyticsScopeSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
  })
  .meta({ title: 'AnalyticsScope' });

export type AnalyticsScopeContract = z.output<typeof analyticsScopeSchema>;

export const exclusionReasonSchema = z
  .enum(['no_live_quote', 'no_price_history'])
  .meta({ title: 'ExclusionReason' });

export const excludedSymbolSchema = z
  .object({
    symbol: z.string(),
    reason: exclusionReasonSchema,
  })
  .meta({ title: 'ExcludedSymbol' });

export type ExcludedSymbolContract = z.output<typeof excludedSymbolSchema>;

export const benchmarkRefusalSchema = z
  .enum(['no_benchmark_history', 'no_baseline'])
  .meta({ title: 'BenchmarkRefusal' });

export const analyticsBenchmarkSchema = z
  .object({
    /** Portfolio line, rebased to 100. */
    portfolio: z.array(chartPointSchema),
    /** Benchmark line, rebased to 100 — EMPTY whenever `degradedReason` is set. */
    benchmark: z.array(chartPointSchema),
    degradedReason: benchmarkRefusalSchema.nullable(),
  })
  .meta({ title: 'AnalyticsBenchmark' });

export type AnalyticsBenchmarkContract = z.output<typeof analyticsBenchmarkSchema>;

export const analyticsResponseSchema = z.object({
  scopeId: uuidSchema.nullable(),
  scopes: z.array(analyticsScopeSchema),
  /** First trade date in scope, 'YYYY-MM-DD'; null when there is nothing. */
  inceptionDateISO: isoDateSchema.nullable(),
  xirr: analyticsMetricSchema,
  twrrAnnualized: analyticsMetricSchema,
  twrrCumulative: analyticsMetricSchema,
  /** Unrealized gain over priced open positions, formatted PLN; null when none. */
  totalGain: displayStringSchema.nullable(),
  totalGainDirection: directionSchema,
  totalValue: displayStringSchema.nullable(),
  breakdown: analyticsBreakdownSchema,
  /** Largest position + score over the ticker slices; null when nothing is priced. */
  concentration: analyticsConcentrationSchema.nullable(),
  /**
   * Target versus actual, for ONE portfolio. Null on the All scope (targets
   * are strictly per portfolio) and null when the scope holds and targets
   * nothing. ADDITIVE: an installed build that ignores the key keeps working.
   */
  targetDrift: analyticsTargetDriftSchema.nullable(),
  benchmark: analyticsBenchmarkSchema,
  excludedSymbols: z.array(excludedSymbolSchema),
  skippedDays: z.number().int(),
  partialDays: z.number().int(),
});

export type AnalyticsResponse = z.output<typeof analyticsResponseSchema>;
