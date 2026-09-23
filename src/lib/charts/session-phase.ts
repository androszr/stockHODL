import type { ChartPoint } from '@/lib/charts/series';
import { nyDateISOAt, regularSessionFor, type CalendarOverride } from '@/lib/market-data/market-clock';

/**
 * Extended-hours classification for intraday chart points, and the contiguous
 * runs the chart shades.
 *
 * WHY it exists: the vendor's 5-minute bars for a US listing span 04:00–20:00
 * ET — pre-market and after-hours are already in the series, they were just
 * drawn as if they were the regular session. The vendor does not label them,
 * so the label is derived: `regularSessionFor()` gives the day's real open and
 * close (DST- and early-close-aware) and each bar falls before, inside or
 * after it.
 *
 * Pure and isomorphic — no `server-only`, no clock reads, no I/O. Tagging runs
 * on the server (where the calendar is), span grouping on the client (where
 * the bands are drawn); both live here so the two halves cannot drift.
 *
 * Every value is a timestamp or an array index. No money crosses this file.
 */

/**
 * Tags each point that falls outside the regular session of its own NY
 * calendar date. Bars are keyed by their START instant, which is what makes
 * `>= closeMs` correct for after-hours: the 15:55 bar runs up to 16:00 and is
 * still regular.
 *
 * A date with no regular session at all (weekend, full closure) leaves its
 * points untagged rather than declaring the whole day extended — a day the
 * calendar says is closed but that carries bars is a contradiction, and the
 * honest answer is to shade nothing rather than shade everything.
 */
export function tagSessionPhases(
  points: readonly ChartPoint[],
  overrides: readonly CalendarOverride[],
): ChartPoint[] {
  const sessionByDate = new Map<string, ReturnType<typeof regularSessionFor>>();

  return points.map((point) => {
    const date = nyDateISOAt(point.t);
    if (!sessionByDate.has(date)) sessionByDate.set(date, regularSessionFor(date, overrides));
    const session = sessionByDate.get(date) ?? null;
    if (!session) return point;

    if (point.t < session.openMs) return { ...point, p: 'pre' as const };
    if (point.t >= session.closeMs) return { ...point, p: 'post' as const };
    return point;
  });
}
