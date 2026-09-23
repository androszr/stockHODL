import { watchedAnchorDate } from '@/lib/watchlist/anchor';

/**
 * The ONE price-chart anchor rule for an INSTRUMENT — pure calendar math, no
 * clock read (`todayISO` is injected, the `resolveRange` convention).
 *
 * A price chart is about the INSTRUMENT, not about the position: what AAPL did
 * last year is the same fact whether the user bought it in 2019 or on Monday.
 * Anchoring an owned instrument at its first trade date (the rule until
 * 2026-08-20) gave the same stock two opposite answers depending on whether it
 * was held or merely watched — a stock bought three days ago charted three
 * points on 1M, 6M and ALL alike, while the identical watched stock charted
 * five years. So the watched five-year floor now applies to held instruments
 * too, and a trade OLDER than that floor still wins: history that exists and
 * predates the floor is real history and stays chartable.
 *
 * Consequence, intended: `ALL` on an owned stock's price chart now means five
 * years, not "since I bought it".
 *
 * The PORTFOLIO value anchor is deliberately UNTOUCHED — it stays the first
 * transaction date, because before that date the user genuinely owned nothing
 * and there is no portfolio value to draw. Do not "unify" the two.
 *
 * Comparison is plain ISO string ordering, the `coverage.ts` convention:
 * 'YYYY-MM-DD' sorts lexicographically iff it sorts chronologically.
 */
export function instrumentAnchorDate(todayISO: string, firstTradeISO: string | null): string {
  const floor = watchedAnchorDate(todayISO);
  if (firstTradeISO === null) return floor;
  return firstTradeISO < floor ? firstTradeISO : floor;
}
