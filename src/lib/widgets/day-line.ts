import { sliceLastSessions } from '@/lib/charts/ranges';
import { downsample, type ChartPoint } from '@/lib/charts/series';
import {
  nyDateISOAt,
  regularSessionFor,
  type CalendarOverride,
} from '@/lib/market-data/market-clock';
import { dec, pctChange, toNumeric, ZERO, type Money } from '@/lib/money';

/**
 * Compact session-percent mapping for the Combined widget's day path.
 *
 * Pure and isomorphic: no `server-only`, no I/O. Decimal via `money.ts` end
 * to end. `p` on the wire is `toNumeric` output, never a JS number.
 */

/** Downsample cap so a widget payload stays skinny. */
export const WIDGET_DAY_LINE_MAX_POINTS = 80;

export interface WidgetDayPoint {
  t: number;
  /** Unformatted decimal-string percent from previous close. */
  p: string;
}

export interface SessionBounds {
  openMs: number;
  closeMs: number;
}

/** Drops extended-hours bars. Absent `p` is the regular session. */
export function regularSessionPoints(points: readonly ChartPoint[]): ChartPoint[] {
  return points.filter((point) => point.p === undefined);
}

/**
 * Trailing regular session, after extended hours have already been dropped —
 * the market-strip order: at 09:08 Warsaw the last regular date is yesterday.
 */
export function lastRegularSession(points: readonly ChartPoint[]): ChartPoint[] {
  return sliceLastSessions(regularSessionPoints(points), 1);
}

/** Regular-session bounds of the NY date that contains `t`, or null. */
export function sessionBounds(
  t: number,
  overrides: readonly CalendarOverride[],
): SessionBounds | null {
  return regularSessionFor(nyDateISOAt(t), overrides);
}

/**
 * Each remaining `v` as percent from `baseline` (previous-close value of
 * that side). A zero baseline yields no points — `pctChange` is undefined
 * and must not become `"0"`.
 */
export function toSessionPercentSeries(
  points: readonly ChartPoint[],
  baseline: string,
): WidgetDayPoint[] {
  const base = dec(baseline);
  const out: WidgetDayPoint[] = [];
  for (const point of points) {
    const pct = pctChange(base, dec(point.v));
    if (pct === null) continue;
    out.push({ t: point.t, p: toNumeric(pct) });
  }
  return out;
}

/** Keep first + last, never rewrite a value. */
export function downsampleDayLine(points: readonly WidgetDayPoint[]): WidgetDayPoint[] {
  const asChart: ChartPoint[] = points.map((point) => ({ t: point.t, v: point.p }));
  return downsample(asChart, WIDGET_DAY_LINE_MAX_POINTS).map((point) => ({
    t: point.t,
    p: point.v,
  }));
}

/**
 * Shared Y cap: max abs of both percent series. Null when nothing parses
 * (callers draw nothing rather than a fabricated flat session).
 */
export function fittedCap(
  holdings: readonly WidgetDayPoint[],
  options: readonly WidgetDayPoint[],
): Money | null {
  let cap = ZERO;
  let any = false;
  for (const point of [...holdings, ...options]) {
    const abs = dec(point.p).abs();
    if (!any || abs.greaterThan(cap)) cap = abs;
    any = true;
  }
  return any ? cap : null;
}

/**
 * Whether Combined may attach `dayLines`. Pre-market must not paint
 * yesterday; a live-coloured path must be this NY date and still running.
 * Closed / late-trading keep yesterday so breakfast in Warsaw stays muted.
 */
export function shouldShipWidgetDayLines(
  status: 'open' | 'closed' | 'early_trading' | 'late_trading' | 'unknown',
  session: SessionBounds,
  nowMs: number,
): boolean {
  if (status === 'early_trading') return false;
  if (status === 'open') {
    if (session.closeMs <= nowMs) return false;
    return nyDateISOAt(session.openMs) === nyDateISOAt(nowMs);
  }
  return true;
}
