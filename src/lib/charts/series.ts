/**
 * Pure chart-series shaping: decimal strings end to end, with no float
 * crossing on the server — the phone's `PlotPoints.swift` turns points into
 * geometry. Isomorphic — no `server-only`, no I/O — so series building and
 * downsampling before serialization can run anywhere.
 */

/**
 * Which trading session a point belongs to, for the bars the market prints
 * OUTSIDE regular hours. Absent means the regular session — the common case
 * carries no field at all, which keeps the serialized payload unchanged for
 * every daily range.
 */
export type SessionPhase = 'pre' | 'post';

export interface ChartPoint {
  /** Epoch ms — a timestamp, not money. */
  t: number;
  /** Decimal string, via the same boundary discipline as every price. */
  v: string;
  /** Extended-hours marker; absent = regular session. Set server-side (the
   *  session calendar lives there), only on the 1D series (instrument and
   *  portfolio). */
  p?: SessionPhase;
  /** Simple return vs open cost basis at this point, as a decimal-string
   *  PERCENT (`pctChange` convention). Set only by the PORTFOLIO builders;
   *  absent = no basis at that point (nothing owned yet / fully liquidated)
   *  — the instrument series never sets it, so its payload serializes
   *  unchanged (the `p?` precedent). */
  r?: string;
  /** Open/high/low for the candlestick view (decimal strings, the same
   *  boundary as `v`). Set only by the INSTRUMENT series, and only on days
   *  whose stored bar carries OHLC — absent means "no candle for this point"
   *  (rows saved before the OHLV columns existed, pending the one-off
   *  repair), which serializes away like `p?`/`r?`. All three or none. */
  o?: string;
  h?: string;
  l?: string;
}

/** The serializable payload both chart Server Actions return. */
export interface SeriesPayload {
  points: ChartPoint[];
  /** Days (or intraday points) summed from an incomplete instrument set. */
  partialDays: number;
  /** Symbols the series could not include at all — named, never zeroed in. */
  excludedSymbols: string[];
  /** First transaction date, or null when there is nothing to chart. */
  anchorDate: string | null;
  /**
   * The date from which the plotted values are the app's OWN model estimates
   * rather than real traded prices — the seam an options line crosses when it
   * runs off the back of mark recording into backfilled traded closes
   * (2026-08-20). Set ONLY by the two options series builders; absent
   * everywhere else, so every other payload serializes byte-identically — the
   * `p?`/`r?` optional-field precedent. Never inferred client-side: a
   * disclosure the server did not make is not a disclosure.
   */
  estimatedFrom?: string;
}

/** Downsampling target: ~400 points keeps 5Y-daily payloads and DOM light. */
export const MAX_PLOT_POINTS = 400;

/**
 * Every-nth downsampling that always keeps the first and the last point and
 * never touches values — string in, the same string out. (LTTB would keep
 * visual extremes better, but it runs on floats; for a portfolio line ~400
 * uniform samples are indistinguishable and the money discipline stays
 * trivially intact.)
 */
export function downsample(
  points: readonly ChartPoint[],
  maxPoints: number = MAX_PLOT_POINTS,
): ChartPoint[] {
  if (maxPoints < 2 || points.length <= maxPoints) return [...points];

  const last = points.length - 1;
  const step = last / (maxPoints - 1);
  const sampled: ChartPoint[] = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    sampled.push(points[Math.round(i * step)]);
  }
  sampled.push(points[last]);
  return sampled;
}

/**
 * The return curve riding on a portfolio payload, as plottable points: only
 * points carrying `r` survive ("percent of nothing" has no meaning — never
 * zeroed, never interpolated), and the percent becomes the plotted `v`.
 * Decimal strings in, decimal strings out — the server has no float
 * crossing; the phone turns points into geometry. Phase tags ride along,
 * absent stays absent.
 */
export function toReturnPoints(points: readonly ChartPoint[]): ChartPoint[] {
  const result: ChartPoint[] = [];
  for (const point of points) {
    if (point.r === undefined) continue;
    result.push(
      point.p === undefined ? { t: point.t, v: point.r } : { t: point.t, v: point.r, p: point.p },
    );
  }
  return result;
}

/** The canonical empty payload — no data, honestly. */
export function emptySeries(anchorDate: string | null = null): SeriesPayload {
  return { points: [], partialDays: 0, excludedSymbols: [], anchorDate };
}
