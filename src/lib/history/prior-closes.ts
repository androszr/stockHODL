import 'server-only';

import { and, desc, eq, inArray, lt } from 'drizzle-orm';

import { db, instruments, priceSnapshots } from '@/lib/db';
import { dec } from '@/lib/money';

/**
 * Leaf reader over the `price_snapshots` cache: the newest cached daily close
 * STRICTLY BEFORE a calendar date, per symbol — the baseline the pre-open
 * rolled-state day-pair substitution measures from (defect fix, 2026-08-14).
 *
 * Deliberately a LEAF: imports only the db/schema and money — never the
 * history read/write module (home of `getLatestClosesBefore`, which already
 * imports the provider adapter, so pulling it in from the adapter's side
 * would close the massive → prior-closes → history → massive import cycle)
 * and never any provider module. That cycle is WHY the batched query below is
 * built locally rather than imported, even though its `DISTINCT ON` shape
 * matches `getLatestClosesBefore`'s: the two also differ in keying (symbol
 * through the join here vs `instrumentId` there) and in degradation (this
 * module THROWS by contract — the caller in massive.ts contains the failure
 * and leaves the vendor pair unsubstituted; `getLatestClosesBefore` is
 * best-effort → empty map). Read-only by design: this module never writes
 * `price_snapshots`.
 *
 * Symbols come exclusively from the caller's own DB rows (holdings /
 * watchlist) — this module adds no path for client-supplied input.
 */

/**
 * Cached rows are immutable (a session's final close never changes), so a
 * FOUND close is memoized without a TTL; misses are deliberately NOT cached —
 * a brand-new instrument's history lands on the nightly cron or any chart
 * view, and a cached miss would hide it until the next cold start. Insertion
 * order doubles as eviction order, same convention as the other in-process
 * caches.
 */
const MAX_MEMO_ENTRIES = 256;
const memo = new Map<string, string>();

/**
 * The narrow slice of the drizzle database the batched query needs —
 * structural, so the SQL-shape test can build the IDENTICAL query over a
 * pg-core `QueryBuilder` and pin the production SQL via `.toSQL()`.
 */
type PriorClosesBuilder = Pick<typeof db, 'selectDistinctOn'>;

/**
 * The ONE query behind `getPriorClosesBySymbol` (2026-08-16 ticker-page plan
 * — was a sequential per-symbol N+1): Postgres `DISTINCT ON (symbol)` with
 * `ORDER BY symbol, as_of DESC` — DISTINCT ON the UNIQUE `instruments.symbol`
 * column, and the ORDER BY must lead with the DISTINCT ON expression (a
 * Postgres requirement); `as_of DESC` makes "newest earlier close per symbol"
 * win, exactly what the per-symbol loop answered. STRICT `lt` on `as_of`: a
 * close ON the boundary day is that day's data, not a baseline.
 */
export function priorClosesQuery(
  builder: PriorClosesBuilder,
  symbols: readonly string[],
  beforeDateISO: string,
) {
  return builder
    .selectDistinctOn([instruments.symbol], {
      symbol: instruments.symbol,
      close: priceSnapshots.close,
    })
    .from(priceSnapshots)
    .innerJoin(instruments, eq(priceSnapshots.instrumentId, instruments.id))
    .where(
      and(inArray(instruments.symbol, [...symbols]), lt(priceSnapshots.asOf, beforeDateISO)),
    )
    .orderBy(instruments.symbol, desc(priceSnapshots.asOf));
}

/**
 * Per symbol, the newest `price_snapshots.close` with `as_of` strictly before
 * `beforeDateISO`, joined through `instruments` on the exact symbol. Symbols
 * with no such row are simply absent from the map — the caller renders the
 * honest dash, never a fabricated zero. Memo hits are served first; the
 * remaining misses go to the database as ONE combined query (equivalence with
 * the retired per-symbol loop is pinned by `prior-closes.test.ts`). THROWS on
 * a database failure — deliberately no internal degradation (contrast
 * `getLatestClosesBefore`'s best-effort empty map): the caller decides, and
 * massive.ts's existing containment logs and leaves the vendor pair as-is.
 */
export async function getPriorClosesBySymbol(
  symbols: readonly string[],
  beforeDateISO: string,
): Promise<Map<string, string>> {
  const closes = new Map<string, string>();

  const misses: string[] = [];
  for (const symbol of new Set(symbols)) {
    const hit = memo.get(`${symbol}:${beforeDateISO}`);
    if (hit !== undefined) {
      closes.set(symbol, hit);
    } else {
      misses.push(symbol);
    }
  }
  // `inArray` with an empty list is a drizzle runtime error, and the
  // all-memoized call path legitimately produces zero misses.
  if (misses.length === 0) return closes;

  const rows = await priorClosesQuery(db, misses, beforeDateISO);
  for (const row of rows) {
    // Re-normalised through dec() so numeric(20,8) padding never leaks.
    const close = dec(row.close).toString();
    if (memo.size >= MAX_MEMO_ENTRIES) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    memo.set(`${row.symbol}:${beforeDateISO}`, close);
    closes.set(row.symbol, close);
  }
  // Symbols the query returned no row for stay absent — and stay uncached
  // (the found-only memo rationale above).
  return closes;
}
