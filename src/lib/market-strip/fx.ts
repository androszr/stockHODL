import type { LiveFigure } from '@/lib/holdings/live-payload';
import { downsample, type ChartPoint } from '@/lib/charts/series';
import type { Candle } from '@/lib/market-data/provider';
import { dec, directionOf, fmtDecimal, fmtPct, pctChange } from '@/lib/money';
import { TREND_SESSIONS_NEEDED, toTrendDays, isEmptyStrip, type TrendSlot } from '@/lib/trend/day-trend';
import { FX_TREND_SCALE } from '@/lib/trend/trend-scale';

/**
 * The USD/PLN tile's figures — pure and isomorphic like `compose.ts`: no
 * `server-only`, no clock read, no I/O. Bars in (decimal strings, the
 * vendor boundary already crossed in `massive-mapping.ts`), formatted strings
 * out. Every amount passes `dec()`; nothing here is ever a JS number except
 * a timestamp.
 *
 * **Why bars and not a quote.** The vendor's snapshot endpoint answers
 * NOT_ENTITLED for currency pairs on this plan (verified 2026-09-20), so the
 * headline and the day's change cannot come from the quote batch the index
 * tiles use. They are worked out from the same aggregates the spark is drawn
 * from: the tip is the newest minute bar's close, the base is a daily close.
 *
 * **Why the day is the UTC clock day, not the NYSE session.** A currency
 * trades from Sunday 22:00 UTC to Friday 22:00 UTC with no bell, so "today's
 * session" is not a thing the New York calendar can answer. The vendor's own
 * daily bars sit at 00:00 UTC (the probe's `t` values), so its daily
 * boundary IS midnight UTC, and this module follows it: the spark is the
 * current UTC day's bars, and the base is the last daily bar whose UTC date
 * is strictly BEFORE the tip's. The NYSE-session slicer and the phase tagger
 * from `charts/` are deliberately not imported — both cut at New York
 * midnight and would shade a 24-hour market with New York bands.
 *
 * Two consequences worth knowing, both honest rather than bugs:
 * - On a Sunday evening the "day" is a two-hour stub after the 22:00 UTC
 *   reopen, measured against Friday's close (the last daily bar before
 *   Sunday). Monday 00:00 UTC then starts a fresh day against Sunday's stub.
 * - The vendor's daily aggregates can include TODAY's still-forming bar.
 *   Taking "the last daily bar" as the base would compare the tip to itself
 *   and print 0,00%; picking by UTC date strictly before the tip is what
 *   keeps the base a completed day.
 */

/** The vendor's ticker for the pair. Only `fx-load.ts` and `series.ts` send it. */
export const FX_TICKER = 'C:USDPLN';
export const FX_PAIR_LABEL = 'USD/PLN';
/** What the figure means — the tile's caption, in the slot `via SPY` takes. */
export const FX_CAPTION = 'PLN per 1 USD';
/** Rates print four decimals everywhere: 3,7955, never 3,80. */
export const FX_FRACTION_DIGITS = 4;

/** The pure output: formatted strings and a downsampled spark, nothing else. */
export interface FxFigures {
  /** `fmtDecimal(tip, 4, 4)`, or null when there is no tip. */
  last: string | null;
  /** The UTC-day move, or null when either end is missing. */
  dayPct: LiveFigure | null;
  /** The tip's UTC day, oldest first. Empty when there are no minute bars. */
  spark: ChartPoint[];
  /** Five UTC-day moves on the daily closes, FX bands; absent when ungradable. */
  trend?: TrendSlot[];
}

export const NULL_FX_FIGURES: Readonly<FxFigures> = Object.freeze({
  last: null,
  dayPct: null,
  spark: [],
});

/**
 * The pair's strip from its daily bars: the last six UTC days that HAVE a
 * bar are the "sessions" (forex trades Sunday evening to Friday, so the
 * NYSE calendar is the wrong ruler here), graded on the FX bands.
 */
export function fxTrend(dailyCandles: readonly Candle[]): TrendSlot[] | undefined {
  const byDay = new Map<string, Candle>();
  for (const candle of [...dailyCandles].sort((a, b) => a.t - b.t)) byDay.set(utcDateISOAt(candle.t), candle);
  const days = [...byDay.keys()].slice(-TREND_SESSIONS_NEEDED);
  if (days.length < 2) return undefined;
  const points = days.map((day) => ({ asOf: day, close: byDay.get(day)!.close }));
  const slots = toTrendDays(days, points, FX_TREND_SCALE);
  return isEmptyStrip(slots) ? undefined : slots;
}

/** Epoch ms → 'YYYY-MM-DD' in UTC. A calendar string, never money. */
export function utcDateISOAt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Keeps the points of the trailing `days` distinct UTC calendar dates — the
 * forex twin of the NYSE-session slicer, cut at 00:00 UTC instead of New York
 * midnight. Input order is preserved; input is expected ascending by `t`.
 */
export function sliceLastUtcDays<T extends { t: number }>(points: readonly T[], days: number): T[] {
  if (days <= 0 || points.length === 0) return [];

  const dates: string[] = [];
  const dateOf = new Map<T, string>();
  for (const point of points) {
    const date = utcDateISOAt(point.t);
    dateOf.set(point, date);
    if (dates[dates.length - 1] !== date) dates.push(date);
  }

  const keep = new Set(dates.slice(-days));
  return points.filter((point) => keep.has(dateOf.get(point) as string));
}

/**
 * The base for the day's change: the newest daily bar whose UTC date is
 * strictly before the tip's UTC date. Chosen by DATE, not by index, so a
 * forming bar for today — which the vendor may include — is skipped rather
 * than compared against itself. Null when no earlier daily bar exists.
 */
export function fxBaseClose(dailyCandles: readonly Candle[], tipMs: number): string | null {
  const tipDate = utcDateISOAt(tipMs);
  let base: Candle | null = null;
  for (const candle of dailyCandles) {
    if (utcDateISOAt(candle.t) >= tipDate) continue;
    if (base === null || candle.t > base.t) base = candle;
  }
  return base?.close ?? null;
}

/**
 * Daily bars + minute bars → the tile's figures. Every figure is null (and
 * the spark empty) when its inputs are missing, independently: a daily
 * failure still leaves the rate and the spark, a minute failure leaves
 * nothing, because the tip is what everything is measured to.
 */
export function composeFxFigures(
  dailyCandles: readonly Candle[],
  intradayCandles: readonly Candle[],
): FxFigures {
  if (intradayCandles.length === 0) return { last: null, dayPct: null, spark: [] };

  const tip = intradayCandles.reduce((newest, candle) => (candle.t > newest.t ? candle : newest));
  const tipClose = dec(tip.close);
  const last = fmtDecimal(tipClose, FX_FRACTION_DIGITS, FX_FRACTION_DIGITS);

  const baseClose = fxBaseClose(dailyCandles, tip.t);
  let dayPct: LiveFigure | null = null;
  if (baseClose !== null) {
    const pct = pctChange(dec(baseClose), tipClose);
    if (pct !== null) dayPct = { text: fmtPct(pct), direction: directionOf(pct) };
  }

  const points: ChartPoint[] = intradayCandles.map((candle) => ({ t: candle.t, v: candle.close }));
  const spark = downsample(sliceLastUtcDays(points, 1));

  return { last, dayPct, spark, trend: fxTrend(dailyCandles) };
}
