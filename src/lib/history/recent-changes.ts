import 'server-only';

import { asc, desc, inArray, lte, sql } from 'drizzle-orm';

import { db, priceSnapshots } from '@/lib/db';
import { dec } from '@/lib/money';
import { TREND_SESSIONS_NEEDED, type ClosePoint } from '@/lib/trend/day-trend';

/**
 * Leaf reader over the `price_snapshots` cache: the newest stored daily
 * closes per INSTRUMENT — the material the five-day trend strip is graded
 * from (plan `2026-08-22-ios-five-day-trend-lights`).
 *
 * A LEAF for `prior-closes.ts`'s reason, and under the same rule: it imports
 * only the db/schema and money, never `src/lib/history/price-history.ts` (the
 * home of `getLatestClosesBefore`, which already imports the provider
 * adapter) and never a provider module. Read-only by design — this module
 * never writes `price_snapshots`.
 *
 * It differs from `prior-closes.ts` in three ways that are all deliberate:
 * it keys by `instrumentId` (both callers hold ids and neither needs the
 * `instruments` join), it returns MANY rows per key rather than one, and it
 * is NOT memoised — the caller's own best-effort wrapper runs once per
 * holdings walk, and a memo keyed by instrument would have to be invalidated
 * the moment the nightly history cron stores a new close.
 *
 * Instrument ids come exclusively from the caller's own rows (holdings /
 * watchlist); this module adds no path for client-supplied input.
 *
 * THROWS on a database failure, exactly like `getPriorClosesBySymbol`: the
 * caller decides how to degrade, and both of this module's callers contain
 * the failure into "no strip".
 */

/**
 * Five day-over-day changes need SIX closes. Re-exported under this module's
 * own name because the off-by-one is the whole reason the number is not
 * `TREND_DAYS`, and the grader owns the arithmetic.
 */
export const CLOSES_NEEDED = TREND_SESSIONS_NEEDED;

/**
 * The narrow slice of the drizzle database the batched query needs —
 * structural, so the SQL-shape test can build the IDENTICAL query over a
 * pg-core `QueryBuilder` and pin the production SQL via `.toSQL()`.
 */
type RecentClosesBuilder = Pick<typeof db, 'select'>;

/**
 * The ONE query behind `getRecentCloses`, and it is one query rather than one
 * per instrument on purpose: a Dashboard of twenty tiles would otherwise open
 * twenty round trips on every cold start.
 *
 * `row_number() over (partition by instrument_id order by as_of desc)` in a
 * subquery, filtered to the first `perInstrument` rows of each partition —
 * the standard Postgres top-N-per-group, and the only shape that survives a
 * `LIMIT` meaning something different per key. The outer `ORDER BY` restates
 * `as_of DESC` because a subquery's ordering is not contractual once it is
 * wrapped.
 */
export function recentClosesQuery(
  builder: RecentClosesBuilder,
  instrumentIds: readonly string[],
  perInstrument: number,
) {
  const ranked = builder
    .select({
      instrumentId: priceSnapshots.instrumentId,
      asOf: priceSnapshots.asOf,
      close: priceSnapshots.close,
      rank: sql<number>`row_number() over (
        partition by ${priceSnapshots.instrumentId}
        order by ${priceSnapshots.asOf} desc
      )`.as('rank'),
    })
    .from(priceSnapshots)
    .where(inArray(priceSnapshots.instrumentId, [...instrumentIds]))
    .as('ranked');

  return builder
    .select({
      instrumentId: ranked.instrumentId,
      asOf: ranked.asOf,
      close: ranked.close,
    })
    .from(ranked)
    .where(lte(ranked.rank, perInstrument))
    .orderBy(asc(ranked.instrumentId), desc(ranked.asOf));
}

/**
 * Per instrument id, its newest stored closes, NEWEST FIRST — the order
 * `toTrendDays` expects. An instrument with no stored history is simply
 * ABSENT from the map rather than present with an empty array: the caller
 * leaves `trend` undefined, and the tile reserves its space and draws
 * nothing. Never a fabricated zero.
 */
export async function getRecentCloses(
  instrumentIds: readonly string[],
  perInstrument: number = CLOSES_NEEDED,
): Promise<Map<string, ClosePoint[]>> {
  const byInstrument = new Map<string, ClosePoint[]>();

  // `inArray` with an empty list is a drizzle runtime error, and an empty
  // book is a legitimate call path (a new account, an empty watchlist).
  const ids = [...new Set(instrumentIds)];
  if (ids.length === 0) return byInstrument;

  for (const row of await recentClosesQuery(db, ids, perInstrument)) {
    const points = byInstrument.get(row.instrumentId) ?? [];
    // Re-normalised through dec() so numeric(20,8) padding never leaks into
    // a percentage — the same discipline `prior-closes.ts` applies.
    points.push({ asOf: row.asOf, close: dec(row.close).toString() });
    byInstrument.set(row.instrumentId, points);
  }

  return byInstrument;
}
