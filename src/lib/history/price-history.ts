import 'server-only';

import { and, desc, eq, gte, inArray, isNull, lt, lte } from 'drizzle-orm';

import { db, priceHistoryCoverage, priceSnapshots } from '@/lib/db';
import { lastCompletedSessionDateISO, nyDateISOAt } from '@/lib/market-data/market-clock';
import { massiveProvider } from '@/lib/market-data/massive';
import type { Candle } from '@/lib/market-data/provider';
import { dec, toNumeric } from '@/lib/money';

import { extendCoverage, missingRanges, type DateRange } from './coverage';

/**
 * Read-through cache for daily closes: `price_snapshots` holds the immutable
 * bars, `price_history_coverage` records the span the provider has already
 * been asked about, and this module is the only writer of either. Session
 * closes never change, so cached rows never invalidate — the whole cache
 * strategy is append-only.
 *
 * Failure discipline is best-effort end to end: a provider or DB failure
 * degrades to "whatever the cache already has" and logs — it never throws
 * into a page or Server Action. Coverage is extended ONLY after a hole was
 * fully fetched AND persisted, so a mid-hole failure leaves the next read to
 * retry exactly the days that were never stored. An EMPTY provider response
 * still extends coverage: for a non-US instrument (the provider is US-only)
 * the answer "no bars, ever" is definitive, and without recording it every
 * chart view would re-query the provider for a hole that can never fill.
 *
 * One more invariant: coverage NEVER reaches past the last COMPLETED NYSE
 * session. Every chart window ends "today", but today's close does not exist
 * until the bell — recording today as covered would permanently skip fetching
 * it (`missingRanges` would only ever ask about tomorrow onward), punching a
 * hole in the middle of the covered span every single day.
 */

/**
 * Fan-out bound for one series build: at most this many instruments get a
 * provider backfill per call (`provider.ts` warns against fanning out the
 * per-symbol aggs endpoint). Instruments beyond the bound still serve
 * whatever the cache holds and catch up on a later view — the series
 * degrades, it never lies.
 */
export const MAX_BACKFILL_SYMBOLS = 12;

export interface HistoryInstrument {
  id: string;
  symbol: string;
  /** Trading currency — Massive prices are USD by construction (US-only). */
  currency: string;
}

/**
 * One stored daily bar. `close` is the immutable record it always was; the
 * OHLV columns (2026-08-16, massive-tier0 plan) are nullable — rows written
 * before the columns existed hold null until the one-off repair fills them.
 * Prices are decimal strings; `volume` is a share COUNT kept as a decimal
 * string only for the `Candle.volume` round-trip — never money math.
 */
export interface DailyBarRow {
  asOf: string;
  close: string;
  open: string | null;
  high: string | null;
  low: string | null;
  volume: string | null;
}

/** The OHLV-only slice the repair writes — `close` is deliberately absent. */
export type OhlcUpdateRow = Omit<DailyBarRow, 'close'>;

/** The IO seams, injectable so the coverage logic is testable without Drizzle. */
export interface PriceHistoryIO {
  readCoverage(instrumentId: string): Promise<DateRange | null>;
  writeCoverage(instrumentId: string, range: DateRange): Promise<void>;
  readBars(instrumentId: string, range: DateRange): Promise<DailyBarRow[]>;
  writeBars(instrumentId: string, rows: DailyBarRow[]): Promise<void>;
  /**
   * Fill OHLV on rows where `open IS NULL` — an UPDATE, never an insert
   * (`onConflictDoNothing` would silently no-op an UPDATE-shaped fix) and
   * NEVER touching `close` (immutability doctrine) or coverage.
   */
  updateNullOhlc(instrumentId: string, rows: OhlcUpdateRow[]): Promise<void>;
  /** Throws on failure — `syncDailyHistory` decides how that degrades. */
  fetchDailyCandles(symbol: string, range: DateRange): Promise<Candle[]>;
}

const realIO: PriceHistoryIO = {
  async readCoverage(instrumentId) {
    const [row] = await db
      .select({ from: priceHistoryCoverage.coveredFrom, to: priceHistoryCoverage.coveredTo })
      .from(priceHistoryCoverage)
      .where(eq(priceHistoryCoverage.instrumentId, instrumentId));
    return row ?? null;
  },

  async writeCoverage(instrumentId, range) {
    await db
      .insert(priceHistoryCoverage)
      .values({
        instrumentId,
        coveredFrom: range.from,
        coveredTo: range.to,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: priceHistoryCoverage.instrumentId,
        set: { coveredFrom: range.from, coveredTo: range.to, updatedAt: new Date() },
      });
  },

  async readBars(instrumentId, range) {
    return db
      .select({
        asOf: priceSnapshots.asOf,
        close: priceSnapshots.close,
        open: priceSnapshots.open,
        high: priceSnapshots.high,
        low: priceSnapshots.low,
        volume: priceSnapshots.volume,
      })
      .from(priceSnapshots)
      .where(
        and(
          eq(priceSnapshots.instrumentId, instrumentId),
          gte(priceSnapshots.asOf, range.from),
          lte(priceSnapshots.asOf, range.to),
        ),
      );
  },

  async writeBars(instrumentId, rows) {
    if (rows.length === 0) return;
    // Prices (and the count-shaped volume string) through toNumeric(dec(...))
    // like `close` always was; null stays null — never a fabricated figure.
    const num = (value: string | null) => (value === null ? null : toNumeric(dec(value), 8));
    await db
      .insert(priceSnapshots)
      .values(
        rows.map((r) => ({
          instrumentId,
          asOf: r.asOf,
          close: toNumeric(dec(r.close), 8),
          open: num(r.open),
          high: num(r.high),
          low: num(r.low),
          volume: num(r.volume),
          // Massive is US-markets-only end to end — its closes are USD by
          // construction, exactly like the live-quote path stamps them.
          currency: 'USD',
          source: 'massive',
        })),
      )
      .onConflictDoNothing({ target: [priceSnapshots.instrumentId, priceSnapshots.asOf] });
  },

  async updateNullOhlc(instrumentId, rows) {
    // Sequential single-row UPDATEs, each guarded by `open IS NULL`: only the
    // OHLV columns move, `close` is never in the SET list, and a row another
    // path already filled is left alone. Small sets (one instrument's nulls),
    // one user — no batching needed.
    const num = (value: string | null) => (value === null ? null : toNumeric(dec(value), 8));
    for (const row of rows) {
      await db
        .update(priceSnapshots)
        .set({
          open: num(row.open),
          high: num(row.high),
          low: num(row.low),
          volume: num(row.volume),
        })
        .where(
          and(
            eq(priceSnapshots.instrumentId, instrumentId),
            eq(priceSnapshots.asOf, row.asOf),
            isNull(priceSnapshots.open),
          ),
        );
    }
  },

  async fetchDailyCandles(symbol, range) {
    return massiveProvider.getAggregates(symbol, {
      multiplier: 1,
      timespan: 'day',
      from: range.from,
      to: range.to,
    });
  },
};

/** One candle → the snapshot row: the NY calendar date of the bar start, the
 *  close, and the full OHLV alongside (mapAggsResults drops partial bars
 *  upstream, so a mapped candle always carries all five). */
function candleToRow(candle: Candle): DailyBarRow {
  return {
    asOf: nyDateISOAt(candle.t),
    close: candle.close,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    volume: candle.volume,
  };
}

/**
 * Fills the coverage holes for one instrument over `wanted` — one provider
 * request per hole, coverage extended only after that hole's bars were
 * persisted, and NEVER past the last completed session (see the module
 * docstring). Never throws: a failed hole logs, leaves coverage untouched for
 * exactly the unasked days, and stops (a later read retries). Returns the
 * number of bars persisted (attempted inserts; duplicates are DB no-ops).
 */
export async function syncDailyHistory(
  io: PriceHistoryIO,
  instrument: HistoryInstrument,
  wanted: DateRange,
  nowMs: number = Date.now(),
): Promise<number> {
  let covered: DateRange | null;
  try {
    covered = await io.readCoverage(instrument.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'coverage read failed';
    console.error(`Price history coverage read failed (${instrument.symbol}): ${message}`);
    return 0;
  }

  // Derived from the pure NYSE calendar with no vendor overrides — erring in
  // the harmless direction only: a holiday counted as "completed" simply has
  // no bar, ever (an empty answer legitimately covers it), and an early-close
  // afternoon keeps coverage one day back until the standard 16:00 ET passes.
  // The dangerous direction — a running session counted as completed — cannot
  // happen, because overrides only ever REMOVE or SHORTEN sessions.
  const lastCompleted = lastCompletedSessionDateISO(nowMs, []);

  let persisted = 0;
  for (const gap of missingRanges(wanted, covered)) {
    // Clamp the askable range to the last completed session: a window ending
    // on a still-running (or not yet opened) session leaves coverage one step
    // back, and the next read after the close pulls exactly the missing day.
    const to = lastCompleted !== null && gap.to > lastCompleted ? lastCompleted : gap.to;
    if (lastCompleted === null || gap.from > to) continue;
    const askable = { from: gap.from, to };

    try {
      const candles = await io.fetchDailyCandles(instrument.symbol, askable);
      // An empty response is an ANSWER (non-US instrument, pre-listing days):
      // the writes below are no-ops but coverage still extends, so the next
      // view reads the cache instead of re-asking about a permanent hole.
      // The filter is defensive: an in-progress bar the vendor tacks past the
      // clamp must never be frozen into `price_snapshots` — a later insert of
      // the FINAL close would be an `onConflictDoNothing` no-op against it.
      const rows = candles.map(candleToRow).filter((row) => row.asOf <= to);
      await io.writeBars(instrument.id, rows);
      covered = extendCoverage(covered, askable);
      await io.writeCoverage(instrument.id, covered);
      persisted += rows.length;
    } catch (error) {
      // Coverage deliberately NOT extended: the days of this gap were never
      // fully stored, so the next read must retry them.
      const message = error instanceof Error ? error.message : 'backfill failed';
      console.error(`Price history backfill failed (${instrument.symbol}): ${message}`);
      return persisted;
    }
  }
  return persisted;
}

/**
 * The write path for the cron refresh (`/api/cron/refresh-history`) and the
 * one-off backfill script: sync one instrument's daily history against the
 * real DB/provider IO. Returns the number of bars persisted. Best-effort like
 * every read here — it logs and returns instead of throwing.
 */
export async function backfillDailyHistory(
  instrument: HistoryInstrument,
  wanted: DateRange,
): Promise<number> {
  // The provider is US-only — a non-USD instrument has nothing to sync.
  if (instrument.currency !== 'USD') return 0;
  return syncDailyHistory(realIO, instrument, wanted);
}

/**
 * The newest cached daily close STRICTLY BEFORE a calendar date, or null.
 * Read-only (no provider call — a missing baseline degrades to the caller's
 * partial behavior): seeds the intraday series' carry-forward so instruments
 * count from the window's first instant.
 */
export async function getLatestCloseBefore(
  instrumentId: string,
  beforeISO: string,
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ close: priceSnapshots.close })
      .from(priceSnapshots)
      .where(and(eq(priceSnapshots.instrumentId, instrumentId), lt(priceSnapshots.asOf, beforeISO)))
      .orderBy(desc(priceSnapshots.asOf))
      .limit(1);
    // Re-normalised through dec() so numeric(20,8) padding never leaks.
    return row ? dec(row.close).toString() : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'baseline read failed';
    console.error(`Price history baseline read failed (${instrumentId}): ${message}`);
    return null;
  }
}

/**
 * The narrow slice of the drizzle database the batched baseline query needs —
 * structural, so the SQL-shape test can build the IDENTICAL query over a
 * pg-core `QueryBuilder` and pin the production SQL via `.toSQL()`.
 */
type LatestClosesBuilder = Pick<typeof db, 'selectDistinctOn'>;

/**
 * The ONE query behind `getLatestClosesBefore`, extracted so the SQL-shape
 * test shares the exact construction: Postgres `DISTINCT ON (instrument_id)`
 * with `ORDER BY instrument_id, as_of DESC` — the ORDER BY must lead with the
 * DISTINCT ON column (a Postgres requirement), and `as_of DESC` makes "newest
 * row per instrument" win. STRICT `lt` on `as_of`: a close ON the boundary
 * day is that day's data, not a baseline.
 */
export function latestClosesBeforeQuery(
  builder: LatestClosesBuilder,
  instrumentIds: readonly string[],
  beforeISO: string,
) {
  return builder
    .selectDistinctOn([priceSnapshots.instrumentId], {
      instrumentId: priceSnapshots.instrumentId,
      close: priceSnapshots.close,
    })
    .from(priceSnapshots)
    .where(
      and(
        inArray(priceSnapshots.instrumentId, [...instrumentIds]),
        lt(priceSnapshots.asOf, beforeISO),
      ),
    )
    .orderBy(priceSnapshots.instrumentId, desc(priceSnapshots.asOf));
}

/**
 * `getLatestCloseBefore` for a whole instrument set in ONE round-trip
 * (2026-08-16, trim-bundle plan — the loop was an N+1 behind every cold
 * 1D/5D portfolio chart). Same answers as running the single-instrument
 * lookup per id, proven by the equivalence test in `latest-closes.test.ts`:
 * instruments with no earlier close are simply ABSENT from the map, exactly
 * like the loop's `null` skips. Read-only, best-effort — a failure logs and
 * returns an empty map (the builder's partial-day behavior is the
 * degradation), never a throw.
 */
export async function getLatestClosesBefore(
  instrumentIds: readonly string[],
  beforeISO: string,
): Promise<Map<string, string>> {
  // `inArray` with an empty list is a drizzle runtime error, and an all-PLN
  // or all-foreign portfolio legitimately reaches this path with zero ids.
  if (instrumentIds.length === 0) return new Map();
  try {
    const rows = await latestClosesBeforeQuery(db, instrumentIds, beforeISO);
    const closes = new Map<string, string>();
    for (const row of rows) {
      // Re-normalised through dec() so numeric(20,8) padding never leaks.
      closes.set(row.instrumentId, dec(row.close).toString());
    }
    return closes;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'baseline read failed';
    console.error(`Price history baseline batch read failed: ${message}`);
    return new Map();
  }
}

/**
 * Daily closes for one instrument over an inclusive window, as a
 * `'YYYY-MM-DD' → decimal string` map. Read-through: backfills coverage holes
 * from the provider first (unless `backfill: false` — the fan-out bound), then
 * serves from `price_snapshots`. Best-effort — returns what the cache has and
 * logs on any failure, never throws.
 */
export async function getDailyCloses(
  instrument: HistoryInstrument,
  wanted: DateRange,
  opts?: { backfill?: boolean },
): Promise<Map<string, string>> {
  // The provider is US-only: a non-USD instrument can never be priced by it,
  // so there is nothing to ask and nothing to record — the empty map is the
  // honest, permanent answer (the caller excludes the symbol explicitly).
  if (instrument.currency !== 'USD') return new Map();

  if (opts?.backfill !== false) {
    await syncDailyHistory(realIO, instrument, wanted);
  }

  try {
    const rows = await realIO.readBars(instrument.id, wanted);
    const closes = new Map<string, string>();
    for (const row of rows) {
      // Re-normalised through dec() so numeric(20,8) padding never leaks:
      // '123.45000000' → '123.45'.
      closes.set(row.asOf, dec(row.close).toString());
    }
    return closes;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'snapshot read failed';
    console.error(`Price history read failed (${instrument.symbol}): ${message}`);
    return new Map();
  }
}

/** One day's bar as the chart consumers read it — close always present, OHLV
 *  null on rows saved before the columns existed (until the one-off repair). */
export interface DailyBar {
  close: string;
  open: string | null;
  high: string | null;
  low: string | null;
}

/**
 * Daily BARS for one instrument over an inclusive window, keyed by day —
 * `getDailyCloses` with the OHLC alongside (volume deliberately not exposed
 * here: no chart consumer reads it, and the stats row gets its volume from
 * the live quote). Same read-through, same best-effort discipline, same
 * `dec()` re-normalisation; a null OHLV column stays null — honest absence,
 * never interpolated.
 */
export async function getDailyBars(
  instrument: HistoryInstrument,
  wanted: DateRange,
  opts?: { backfill?: boolean },
): Promise<Map<string, DailyBar>> {
  if (instrument.currency !== 'USD') return new Map();

  if (opts?.backfill !== false) {
    await syncDailyHistory(realIO, instrument, wanted);
  }

  try {
    const rows = await realIO.readBars(instrument.id, wanted);
    const bars = new Map<string, DailyBar>();
    const norm = (value: string | null) => (value === null ? null : dec(value).toString());
    for (const row of rows) {
      bars.set(row.asOf, {
        close: dec(row.close).toString(),
        open: norm(row.open),
        high: norm(row.high),
        low: norm(row.low),
      });
    }
    return bars;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'snapshot read failed';
    console.error(`Price history read failed (${instrument.symbol}): ${message}`);
    return new Map();
  }
}

/**
 * The one-off OHLV repair (2026-08-16, massive-tier0 plan): coverage blocks
 * `syncDailyHistory` from ever re-asking about covered days, so rows saved
 * before the OHLV columns existed can ONLY gain them through this explicit
 * pass. Within `range`, re-fetches the span whose rows have `open IS NULL`
 * and UPDATEs only the null OHLV columns — `close` is never overwritten
 * (immutability doctrine) and coverage is never touched (extending or
 * shrinking it here would corrupt the read path's bookkeeping). Injectable
 * IO like `syncDailyHistory`; never throws — a failure logs and returns the
 * rows repaired so far. Returns the number of rows an update was issued for.
 */
export async function repairMissingOhlc(
  io: PriceHistoryIO,
  instrument: HistoryInstrument,
  range: DateRange,
): Promise<number> {
  try {
    const rows = await io.readBars(instrument.id, range);
    const missing = new Set(rows.filter((r) => r.open === null).map((r) => r.asOf));
    if (missing.size === 0) return 0;

    const days = [...missing].sort();
    // ONE provider request spanning the null rows — the aggs endpoint is
    // per-symbol and must not be fanned out per day.
    const candles = await io.fetchDailyCandles(instrument.symbol, {
      from: days[0],
      to: days[days.length - 1],
    });
    const updates = candles
      .map(candleToRow)
      .filter((row) => missing.has(row.asOf))
      .map(({ asOf, open, high, low, volume }) => ({ asOf, open, high, low, volume }));
    if (updates.length === 0) return 0;

    await io.updateNullOhlc(instrument.id, updates);
    return updates.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ohlc repair failed';
    console.error(`Price history OHLC repair failed (${instrument.symbol}): ${message}`);
    return 0;
  }
}

/**
 * The real-IO repair entry the backfill script walks: one instrument, over
 * its OWN covered span (there is nothing to repair outside coverage — an
 * uncovered day has no row at all and belongs to the ordinary sync path).
 * Non-USD instruments have no provider history and return 0 immediately.
 */
export async function repairInstrumentOhlc(instrument: HistoryInstrument): Promise<number> {
  if (instrument.currency !== 'USD') return 0;
  let covered: DateRange | null;
  try {
    covered = await realIO.readCoverage(instrument.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'coverage read failed';
    console.error(`Price history coverage read failed (${instrument.symbol}): ${message}`);
    return 0;
  }
  if (covered === null) return 0;
  return repairMissingOhlc(realIO, instrument, covered);
}
