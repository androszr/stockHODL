import 'server-only';

import { and, inArray, like, max, min } from 'drizzle-orm';

import { db, optionDailyCloses } from '@/lib/db';
import { addDaysIso } from '@/lib/fx/nbp-mapping';
import { lastCompletedSessionDateISO, nyDateISOAt } from '@/lib/market-data/market-clock';
import { getOptionDailyCloses } from '@/lib/market-data/massive';
import type { Candle } from '@/lib/market-data/provider';

/**
 * The option daily-close recorder — the ONLY writer of `option_daily_closes`
 * (the `price-history.ts` single-writer discipline). TWO ENTRY POINTS, and the
 * difference between them is the whole story of this module:
 *
 * A. {@link syncOptionDailyCloses} — the POLL path. Two jobs in one pass:
 *
 *    1. RECORDING (FORWARD-ONLY, user decision 2026-08-15 — scoped to THIS
 *       path since 2026-08-20): completed-session bars are persisted from the
 *       recording edge forward — the first row a contract ever gets on this
 *       path is the last COMPLETED session at first sync, and the poll never
 *       reaches behind it. The `LOOKBACK_DAYS` window below exists only to
 *       DATE thin contracts' last prints, never to seed history: a 60-second
 *       poll must not turn into a history importer.
 *    2. FRESHNESS: the full in-memory bar window (including today's
 *       still-forming bar, which is never persisted — the coverage-clamp
 *       precedent) is returned for `resolveOptionPrints`, which uses the
 *       newest bar to out-vote a stale snapshot on illiquid contracts.
 *
 * B. {@link backfillOptionDailyCloses} — the EXPLICIT backfill (2026-08-20, on
 *    the user's decision). A separate, deliberate entry: the nightly cron's
 *    self-heal leg calls it with an explicit window (the one-off backfill CLI
 *    that also called it was retired 2026-09-23), and it writes every
 *    completed session the vendor has in that window. It touches neither the TTL cache nor the recording-edge
 *    query, so (A) keeps its behaviour byte for byte.
 *
 *    Why the reversal is safe HERE and nowhere else: these are REAL TRADED
 *    PRINTS the vendor still serves for past dates, so a backfilled row is the
 *    same kind of fact a recorded one is. `option_daily_marks` gets NO
 *    equivalent, ever: there is no historical IV/greeks endpoint on this tier,
 *    so a "backfilled mark" would be a fabricated number wearing a real
 *    number's provenance. Do not add one.
 *
 * COST BOUND, stated: the 60 s poll must never fan out one aggregates request
 * per contract per tick. The per-ticker in-process TTL (15 min, successes
 * only — the `searchCache` rules) is the budget; `force: true` (the nightly
 * cron) bypasses it. Do not "improve" the TTL downward.
 *
 * Errors degrade PER TICKER (message-only logs, return what succeeded) — the
 * Options tab never breaks on the sync.
 *
 * SCOPE NOTE (2026-08-15, amended 2026-08-20): `option_daily_closes` is the
 * DATING and FALLBACK record. Cards, totals and TODAY's figures are priced
 * from the model marks in `option_daily_marks` (`mark-sync.ts`) — unchanged.
 * Since 2026-08-20 the value CHART additionally reads these rows for dates
 * that carry no mark (`portfolio-series.ts` is the only reader), which is what
 * the backfill above exists to fill. Marks still win on any date that has one.
 */

/** The poll-path budget: at most one aggregates request per ticker per 15 min
 *  per instance. */
const SYNC_TTL_MS = 15 * 60 * 1000;

/** In-memory lookback, calendar days — deep enough to date a thin contract's
 *  last print (measured: 23 bars over six weeks on the reference contract).
 *  NOT a backfill window: persistence is gated by the recording edge below. */
const LOOKBACK_DAYS = 35;

const MAX_CACHE_ENTRIES = 200;

interface BarCacheEntry {
  at: number;
  bars: Candle[];
}

/** Per-instance, successes only; insertion order doubles as eviction order. */
const barCache = new Map<string, BarCacheEntry>();

export async function syncOptionDailyCloses(
  tickers: readonly string[],
  opts: { force?: boolean } = {},
): Promise<Map<string, Candle[]>> {
  const result = new Map<string, Candle[]>();
  const unique = [...new Set(tickers)];
  if (unique.length === 0) return result;

  const nowMs = Date.now();

  // Cache pass first: a hit costs nothing and needs no persistence re-run —
  // the recording edge already advanced when the bars were first fetched.
  const toFetch: string[] = [];
  for (const ticker of unique) {
    const hit = barCache.get(ticker);
    if (!opts.force && hit && nowMs - hit.at < SYNC_TTL_MS) {
      result.set(ticker, hit.bars);
    } else {
      toFetch.push(ticker);
    }
  }
  if (toFetch.length === 0) return result;

  const todayISO = nyDateISOAt(nowMs);
  const fromISO = addDaysIso(todayISO, -LOOKBACK_DAYS);
  // Conservative without overrides (the price-history.ts:164 precedent):
  // a holiday called "completed" simply has no bar, so recording self-corrects
  // — no session → no bar → no row.
  const lastCompleted = lastCompletedSessionDateISO(nowMs, []);

  // The recording edge per ticker, one grouped read. A failed read degrades to
  // fetch-without-persist: the honest bars still flow to the resolver, and the
  // next run retries the database.
  let maxExistingByTicker: Map<string, string> | null = null;
  try {
    const rows = await db
      .select({ ticker: optionDailyCloses.ticker, maxAsOf: max(optionDailyCloses.asOf) })
      .from(optionDailyCloses)
      .where(inArray(optionDailyCloses.ticker, toFetch))
      .groupBy(optionDailyCloses.ticker);
    maxExistingByTicker = new Map();
    for (const row of rows) {
      if (row.maxAsOf !== null) maxExistingByTicker.set(row.ticker, row.maxAsOf);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'recording-edge read failed';
    console.error(`Option close sync: recording-edge read failed: ${message}`);
  }

  // Sequential, deliberately — the per-symbol aggs endpoint is never fanned
  // out (the massive.ts rule), and the set is a handful of tracked contracts.
  for (const ticker of toFetch) {
    let bars: Candle[];
    try {
      bars = await getOptionDailyCloses(ticker, fromISO, todayISO);
    } catch (error) {
      // Never the key, the header, or a URL — message/status only.
      const message = error instanceof Error ? error.message : 'option bars fetch failed';
      console.error(`Option close sync failed (${ticker}): ${message}`);
      continue; // per-ticker degradation: no cache entry, no result entry
    }

    // Persist rule (the recording edge): only bars strictly newer than what
    // is already stored, never past the last completed session (today's
    // still-forming bar stays in-memory only), and — when NO row exists yet —
    // only the last completed session itself: day one records one point, not
    // the lookback window. Failure here never loses the in-memory bars.
    if (lastCompleted !== null && maxExistingByTicker !== null) {
      const maxExisting = maxExistingByTicker.get(ticker) ?? null;
      const rows = bars
        .map((bar) => ({ ticker, asOf: nyDateISOAt(bar.t), close: bar.close }))
        .filter((row) =>
          maxExisting === null
            ? row.asOf === lastCompleted
            : row.asOf > maxExisting && row.asOf <= lastCompleted,
        );
      if (rows.length > 0) {
        try {
          // Final closes are immutable — re-running a day is a no-op by PK.
          await db.insert(optionDailyCloses).values(rows).onConflictDoNothing();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'close persist failed';
          console.error(`Option close persist failed (${ticker}): ${message}`);
        }
      }
    }

    if (barCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = barCache.keys().next().value;
      if (oldest !== undefined) barCache.delete(oldest);
    }
    barCache.set(ticker, { at: nowMs, bars });
    result.set(ticker, bars);
  }

  return result;
}

/** One contract's backfill window — the ticker and where to start. */
export interface OptionBackfillEntry {
  /** OCC-form vendor ticker. */
  ticker: string;
  /** Inclusive left edge, 'YYYY-MM-DD' — from `optionBackfillFrom`. */
  fromISO: string;
}

/**
 * The `source` prefix an explicitly BACKFILLED row carries — the poll path
 * keeps the column's `'massive'` default. The full value is
 * `` `${BACKFILL_SOURCE_PREFIX}${fromISO}` ``.
 *
 * It is provenance AND the attempt record (2026-08-20): the data floor alone
 * cannot answer "has this window already been walked?", because a contract
 * whose earliest vendor bar is LATER than the window's left edge looks
 * under-covered forever and would be re-fetched every night for nothing
 * (measured on a real far-dated contract: a lot opened in late May had
 * exactly one real bar by mid-August). A row wearing this source says the vendor's window
 * was asked for from this date and this bar is what came back.
 *
 * The WINDOW is part of the receipt, not just the fact of walking (fix of
 * 2026-08-20): a backdated lot imported later LOWERS a contract's
 * `optionBackfillFrom`, and a receipt that only said "walked" would skip the
 * re-walk forever — holing the whole-book chart on every day between the new
 * lot's trade date and the old floor, since `requireEveryActiveLot` drops any
 * day one active lot cannot be priced.
 */
const BACKFILL_SOURCE_PREFIX = 'massive-backfill:';

/** The `source` written for a walk that started at `fromISO`. */
function backfillSource(fromISO: string): string {
  return `${BACKFILL_SOURCE_PREFIX}${fromISO}`;
}

/**
 * The earliest stored `as_of` per ticker, plus whether the ticker carries any
 * explicitly backfilled row — how a caller asks "does this contract already
 * have history behind it?" without learning the table.
 *
 * It lives HERE rather than in the cron route so `option_daily_closes` keeps
 * exactly one module touching it: one writer, and every read of its shape
 * beside the writes that produce it. A ticker with no rows is simply absent
 * from the map (never a `null` entry a caller could confuse with a date).
 */
export async function optionCloseFloors(
  tickers: readonly string[],
): Promise<Map<string, string>> {
  const floors = new Map<string, string>();
  const unique = [...new Set(tickers)];
  if (unique.length === 0) return floors;

  const rows = await db
    .select({ ticker: optionDailyCloses.ticker, minAsOf: min(optionDailyCloses.asOf) })
    .from(optionDailyCloses)
    .where(inArray(optionDailyCloses.ticker, unique))
    .groupBy(optionDailyCloses.ticker);
  for (const row of rows) {
    if (row.minAsOf !== null) floors.set(row.ticker, row.minAsOf);
  }
  return floors;
}

/**
 * The WINDOW each ticker's backfill has already been walked from — the earliest
 * `fromISO` any of its rows carries in {@link BACKFILL_SOURCE_PREFIX}.
 *
 * The cron's self-heal compares this with the window the contract SHOULD have
 * now: equal or wider (`walked <= wanted`) means there is nothing left to ask
 * for, so a thin contract whose real history starts after the window's left
 * edge costs exactly ONE vendor request, ever, instead of one per night; a
 * wanted window that reaches FURTHER BACK than the walked one (a backdated lot
 * arrived) re-walks. A contract for which the vendor has NO bar at all in the
 * window gets no receipt and is retried — correct: there is nothing stored to
 * prove the attempt, and the next night may be the night it prints.
 *
 * A legacy bare `'massive-backfill'` row (written before the window joined the
 * receipt) is deliberately NOT parsed: its window is unknown, so the ticker is
 * walked once more and upgraded to a dated receipt. One extra request per
 * contract, once, in exchange for never trusting a window we cannot read.
 */
export async function optionBackfilledWindows(
  tickers: readonly string[],
): Promise<Map<string, string>> {
  const walked = new Map<string, string>();
  const unique = [...new Set(tickers)];
  if (unique.length === 0) return walked;

  const rows = await db
    .selectDistinct({ ticker: optionDailyCloses.ticker, source: optionDailyCloses.source })
    .from(optionDailyCloses)
    .where(
      and(
        inArray(optionDailyCloses.ticker, unique),
        like(optionDailyCloses.source, `${BACKFILL_SOURCE_PREFIX}%`),
      ),
    );
  for (const row of rows) {
    const from = row.source.slice(BACKFILL_SOURCE_PREFIX.length);
    if (from === '') continue;
    const seen = walked.get(row.ticker);
    if (seen === undefined || from < seen) walked.set(row.ticker, from);
  }
  return walked;
}

/**
 * The EXPLICIT option-close backfill (2026-08-20) — entry (B) in the module
 * note above. Per ticker, fetch the vendor's daily bars over
 * `[fromISO, today]` and store every one that belongs to a COMPLETED session.
 *
 * What it deliberately does NOT do:
 * - **No `barCache` read or write.** Those entries feed `resolveOptionPrints`
 *   via `live-view.ts`; parking a 63-bar list under a ticker key would change
 *   what the freshness resolver sees, for no benefit.
 * - **No recording-edge query.** The whole point is to reach BEHIND the edge;
 *   `onConflictDoNothing` on the `(ticker, as_of)` primary key is what makes a
 *   second run store nothing, so the poll path's edge logic is not needed and
 *   is not touched.
 * - **Never today's bar.** The clamp on `lastCompletedSessionDateISO` is
 *   load-bearing, not defensive: a still-forming bar written now becomes
 *   PERMANENT — the evening's real close would land on `onConflictDoNothing`
 *   and be silently discarded.
 * - **No gap filling.** A session the contract genuinely did not trade has no
 *   bar, gets no row, and stays a hole on the chart. Thin contracts look
 *   gappy because they are.
 *
 * Sequential over tickers (the per-symbol aggs endpoint is never fanned out),
 * per-ticker degradation, message-only logs — never the key, a header or a
 * URL. Returns rows-attempted per ticker (the count offered to the vendor's
 * completed bars; conflicts are not subtracted, so an idempotent re-run of a
 * fully-stored contract reports the same number it stored the first time only
 * when nothing was there before — callers report the DELTA by reading the
 * table, which is what the CLI does).
 */
export async function backfillOptionDailyCloses(
  entries: readonly OptionBackfillEntry[],
): Promise<Map<string, number>> {
  const stored = new Map<string, number>();
  if (entries.length === 0) return stored;

  const nowMs = Date.now();
  const todayISO = nyDateISOAt(nowMs);
  // Conservative without calendar overrides, the `syncOptionDailyCloses`
  // precedent: a holiday called "completed" simply has no bar.
  const lastCompleted = lastCompletedSessionDateISO(nowMs, []);
  if (lastCompleted === null) return stored;

  for (const entry of entries) {
    if (entry.fromISO > lastCompleted) {
      stored.set(entry.ticker, 0);
      continue;
    }

    let bars: Candle[];
    try {
      bars = await getOptionDailyCloses(entry.ticker, entry.fromISO, todayISO);
    } catch (error) {
      // Never the key, the header, or a URL — message only.
      const message = error instanceof Error ? error.message : 'option bars fetch failed';
      console.error(`Option close backfill failed (${entry.ticker}): ${message}`);
      continue; // per-ticker degradation
    }

    const source = backfillSource(entry.fromISO);
    // Deduped by `as_of` before the insert: `onConflictDoUpdate` throws
    // "cannot affect row a second time" if one batch carries two rows with the
    // same conflict target, and two vendor bars CAN in principle map to one NY
    // calendar date. Last bar of a date wins — they are the same session.
    const byAsOf = new Map<string, { ticker: string; asOf: string; close: string; source: string }>();
    for (const bar of bars) {
      const asOf = nyDateISOAt(bar.t);
      if (asOf < entry.fromISO || asOf > lastCompleted) continue;
      byAsOf.set(asOf, { ticker: entry.ticker, asOf, close: bar.close, source });
    }
    const rows = [...byAsOf.values()];

    if (rows.length === 0) {
      stored.set(entry.ticker, 0);
      continue;
    }

    try {
      // Final closes are IMMUTABLE — a re-run never rewrites a `close`, an
      // `as_of` or a `fetched_at`. The one column it does settle is `source`:
      // a bar the poll happened to record first is still a bar this backfill
      // confirmed present in the vendor's window FROM THIS DATE, and that
      // dated receipt is what stops the nightly self-heal re-asking forever
      // while still letting a widened window re-walk (see
      // BACKFILL_SOURCE_PREFIX).
      await db
        .insert(optionDailyCloses)
        .values(rows)
        .onConflictDoUpdate({
          target: [optionDailyCloses.ticker, optionDailyCloses.asOf],
          set: { source },
        });
      stored.set(entry.ticker, rows.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'close persist failed';
      console.error(`Option close backfill persist failed (${entry.ticker}): ${message}`);
    }
  }

  return stored;
}
