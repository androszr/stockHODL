import { addDaysIso } from '@/lib/dates';
import { nyDateISOAt } from '@/lib/market-data/market-clock';
import type { Candle } from '@/lib/market-data/provider';

/**
 * The EIGHT chart ranges — defined once, here, for both charts (portfolio
 * value on Holdings and instrument price on `/holdings/[ticker]`). Pure and
 * isomorphic: no `server-only`, no clock reads (`today` is always injected),
 * no I/O — which is what keeps the window math unit-testable.
 *
 * Dates are plain 'YYYY-MM-DD' strings; timestamps are epoch ms. Calendar
 * data, never money.
 */

export const CHART_RANGES = ['1D', '5D', '1M', '6M', 'YTD', '1Y', '5Y', 'ALL'] as const;

export type ChartRange = (typeof CHART_RANGES)[number];

/**
 * The options chart's subset (2026-08-15): DAILY-ONLY — option intraday bars
 * are near-nonexistent (verified: zero 5-minute results on a thin contract),
 * so 1D/5D are deliberately absent; 5Y is pointless for recording that
 * started this week and for contracts that expire within two years.
 */
export const OPTIONS_CHART_RANGES = ['1M', '6M', 'YTD', '1Y', 'ALL'] as const satisfies
  readonly ChartRange[];

/**
 * The range a chart opens on when nothing is remembered — server prerender and
 * client first paint BOTH read this, so the SSR'd series and the hydrated
 * `initialRange` cannot drift apart (a mismatch would refetch on mount and
 * flash a skeleton over an already-painted chart).
 */
export const DEFAULT_CHART_RANGE: ChartRange = '1D';

/** Daily-granularity window, inclusive ISO dates. */
export interface ResolvedDailyRange {
  kind: 'daily';
  from: string;
  to: string;
}

/**
 * Intraday window: a calendar-day lookback WIDE ENOUGH to contain the wanted
 * sessions plus any weekend/holiday padding, with `sessions` saying how many
 * trailing sessions actually get charted (`sliceLastSessions`). Resolving
 * "the last completed session" from a date alone cannot know holidays — the
 * over-wide fetch plus a trailing slice answers it from the DATA instead: on
 * a Saturday or a holiday Monday, the newest bars in the window simply ARE
 * the last completed session.
 */
export interface ResolvedIntradayRange {
  kind: 'intraday';
  /** Bar size in minutes — 5 for 1D, 30 for 5D. */
  multiplier: 5 | 30;
  /** Epoch ms bounds for the vendor request (stringified into `BarSpec`). */
  fromMs: number;
  toMs: number;
  /** Chart the trailing N distinct sessions found in the response. */
  sessions: 1 | 5;
}

export type ResolvedRange = ResolvedDailyRange | ResolvedIntradayRange;

export interface RangeContext {
  /** Today's calendar date (NY for market data), injected — never `new Date()` here. */
  today: string;
  /**
   * First transaction date — the portfolio's earliest overall, or the
   * instrument's own on its page. Null (no transactions) resolves every range
   * to null: an empty state, never a provider query.
   */
  anchorDate: string | null;
}

const MS_PER_DAY = 86_400_000;

/** Calendar lookbacks for the intraday windows: enough days to guarantee the
 *  wanted session count survives weekends and holiday clusters. */
const INTRADAY_LOOKBACK_DAYS: Record<'1D' | '5D', number> = { '1D': 6, '5D': 12 };

/** 'YYYY-MM-DD' → UTC-midnight epoch ms. Calendar integers, never money. */
function isoToUtcMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** Calendar-month subtraction with end-of-month clamping (Mar 31 − 1M → Feb 28).
 *  Date parts are calendar integers, not money — `parseInt` on them is correct
 *  and stays confined to this helper (same rationale as `@/lib/dates`). */
export function addMonthsIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map((part) => parseInt(part, 10));
  const targetMonthIndex = m - 1 + delta;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  // Day 0 of the NEXT month = the last day of the target month.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(targetYear).padStart(4, '0')}-${pad(targetMonth + 1)}-${pad(day)}`;
}

/**
 * Range → concrete window, clamped to the anchor: 5Y on a portfolio opened
 * six months ago charts six months, not five years of emptiness; ALL starts
 * exactly at the first transaction. Null without an anchor (no transactions).
 */
export function resolveRange(range: ChartRange, ctx: RangeContext): ResolvedRange | null {
  const { today, anchorDate } = ctx;
  if (anchorDate === null) return null;

  if (range === '1D' || range === '5D') {
    const lookback = INTRADAY_LOOKBACK_DAYS[range];
    const fromIso = addDaysIso(today, -lookback);
    const clampedFrom = fromIso < anchorDate ? anchorDate : fromIso;
    return {
      kind: 'intraday',
      multiplier: range === '1D' ? 5 : 30,
      fromMs: isoToUtcMs(clampedFrom > today ? today : clampedFrom),
      // Through the end of today plus a day of slack: late trading crosses
      // UTC midnight, and the vendor simply clamps a future bound to "now".
      toMs: isoToUtcMs(today) + 2 * MS_PER_DAY,
      sessions: range === '1D' ? 1 : 5,
    };
  }

  let from: string;
  switch (range) {
    case '1M':
      from = addMonthsIso(today, -1);
      break;
    case '6M':
      from = addMonthsIso(today, -6);
      break;
    case 'YTD':
      from = `${today.slice(0, 4)}-01-01`;
      break;
    case '1Y':
      from = addMonthsIso(today, -12);
      break;
    case '5Y':
      from = addMonthsIso(today, -60);
      break;
    case 'ALL':
      from = anchorDate;
      break;
  }

  if (from < anchorDate) from = anchorDate;
  if (from > today) from = today;
  return { kind: 'daily', from, to: today };
}

/** How the categorical intraday axis places and labels its ticks. */
export interface IntradayAxisTicks {
  /** Indices into the plotted points where ticks belong. */
  tickIndices: number[];
  /** 'day' — first bar of each session (multi-session windows); 'hour' —
   *  first bar of each clock hour (a single session). */
  unit: 'day' | 'hour';
}

/**
 * Tick positions for the CATEGORICAL intraday axis. Intraday points are
 * plotted by index, not by timestamp (Yahoo-style): overnight and weekend
 * gaps carry no bars, and a continuous time axis would render them as long
 * straight diagonals spanning half the chart — closed market drawn as if it
 * were data. With sessions glued together the axis positions carry no time
 * meaning, so tick placement must come from the data itself: session starts
 * across a multi-day window, hour starts within a single session. Labels are
 * always formatted from the point's real `t`.
 */
export function intradayAxisTicks(ts: readonly number[]): IntradayAxisTicks {
  const sessionStarts: number[] = [];
  let prevDate: string | null = null;
  for (let i = 0; i < ts.length; i++) {
    const date = nyDateISOAt(ts[i]);
    if (date !== prevDate) {
      sessionStarts.push(i);
      prevDate = date;
    }
  }
  if (sessionStarts.length > 1) return { tickIndices: sessionStarts, unit: 'day' };

  const hourStarts: number[] = [];
  let prevHour: number | null = null;
  for (let i = 0; i < ts.length; i++) {
    // Whole-hour epoch boundaries coincide with wall-clock hour changes in
    // every whole-hour-offset zone (NY and Warsaw both are). A count, not money.
    const hour = Math.floor(ts[i] / 3_600_000);
    if (hour !== prevHour) {
      hourStarts.push(i);
      prevHour = hour;
    }
  }
  return { tickIndices: hourStarts, unit: 'hour' };
}

/**
 * Keeps the candles of the trailing `sessions` distinct NY calendar dates —
 * how an over-wide intraday fetch becomes "the last (completed) session(s)".
 * Input order is preserved; input is expected ascending by `t` (the vendor's
 * `sort=asc`).
 *
 * SCOPE NOTE (2026-08-14): this slices ONE instrument's candles, which is
 * correct on the single-instrument chart — its own trailing session IS the
 * chart's session. The PORTFOLIO intraday path must NOT slice per instrument:
 * an active stock's "last session" can be today (pre-market bars) while a
 * quiet stock's is still yesterday, and gluing those axes together draws a
 * vertical cliff at the boundary. The portfolio builder slices portfolio-wide
 * via {@link lastSharedSessionDates} instead.
 *
 * Generic over anything carrying a bar-start `t` (2026-09-04): the market
 * strip slices already-tagged `ChartPoint`s rather than raw `Candle`s, because
 * the extended-hours bars have to be dropped BEFORE the trailing session is
 * chosen (at 05:00 ET the newest date is today, and it holds nothing but
 * pre-market). Type-level only — a `Candle[]` caller still gets a `Candle[]`
 * back and the body is unchanged.
 */
export function sliceLastSessions<T extends { t: number }>(
  candles: readonly T[],
  sessions: number,
): T[] {
  if (sessions <= 0 || candles.length === 0) return [];

  const dates: string[] = [];
  const dateOf = new Map<T, string>();
  for (const candle of candles) {
    const date = nyDateISOAt(candle.t);
    dateOf.set(candle, date);
    if (dates[dates.length - 1] !== date) dates.push(date);
  }

  const keep = new Set(dates.slice(-sessions));
  return candles.filter((candle) => keep.has(dateOf.get(candle) as string));
}

/**
 * The trailing `sessions` distinct NY calendar dates across the UNION of all
 * lists' bars, ascending — ONE shared session window for a whole portfolio.
 * The window ends at the newest session ANY instrument printed: data-driven
 * like {@link sliceLastSessions} (a clock cannot know holidays, and would
 * yield an empty chart in the 04:00-ET-to-first-print gap), but computed over
 * every instrument at once so no instrument can pick its own trailing day.
 * Pure and isomorphic — no clock reads, no I/O; dates are calendar strings,
 * never money.
 */
export function lastSharedSessionDates(
  candleLists: Iterable<readonly Candle[]>,
  sessions: number,
): string[] {
  if (sessions <= 0) return [];
  const dates = new Set<string>();
  for (const candles of candleLists) {
    for (const candle of candles) dates.add(nyDateISOAt(candle.t));
  }
  return [...dates].sort().slice(-sessions);
}
