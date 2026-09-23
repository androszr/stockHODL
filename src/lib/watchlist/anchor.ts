import { addMonthsIso } from '@/lib/charts/ranges';

/**
 * The chart anchor for a WATCHED instrument — pure calendar math, no clock
 * read (`todayIso` is injected, the `resolveRange` convention).
 *
 * An owned instrument anchors its chart at the first trade date; a watched
 * one has no trades, and a null anchor would render every range empty. The
 * policy: a fixed FIVE-YEAR lookback (`addMonthsIso(today, -60)` — exactly
 * the 5Y range's own window), so `ALL` charts five years and, critically, the
 * daily-close backfill `getDailyCloses` runs from a BOUNDED past instead of
 * an unbounded one. End-of-month clamping comes from `addMonthsIso` itself.
 */
export function watchedAnchorDate(todayIso: string): string {
  return addMonthsIso(todayIso, -60);
}
