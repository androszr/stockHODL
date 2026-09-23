import 'server-only';

import { inArray, max, sql } from 'drizzle-orm';

import { db, latestQuotes } from '@/lib/db';
import { dec, toNumeric } from '@/lib/money';

import type { Quote } from './provider';

/**
 * The durable quote cache — the ONLY reader/writer of `latest_quotes` (the
 * `calendar-store.ts` single-writer convention). Wired 2026-08-16
 * (massive-tier0 plan): every good price the app fetches is also written
 * here, so a vendor outage or a cold start can show the LAST SAVED price in
 * a muted style with its fetch time instead of a blank dash. Display-only
 * downstream by decision: cached rows never enter the position engine, the
 * summary or the charts — `excludedSymbols` honesty is untouched.
 *
 * Failure discipline, calendar-store verbatim: NOTHING here throws into a
 * caller. Cache I/O is strictly best-effort — a write or read failure logs
 * (message only, never a key or URL) and degrades to "no cached entry";
 * live quotes never break on the cache.
 */

/**
 * In-process write throttle: the Holdings poll runs every 10 s, and without
 * a floor that is 6 writes/min — 8 640/day — for figures whose staleness
 * tolerance here is measured in hours. Per-instance and in-process on
 * purpose: a cold start writes immediately, which is exactly when the cache
 * matters most.
 *
 * Keyed PER INSTRUMENT-ID SET, not one global timestamp (2026-08-16 gap
 * fix): a single shared clock would let the polling Holdings surface re-arm
 * the window against the Watchlist and the ticker page's watched branch —
 * a watched-only symbol's one-shot page load would then be skipped ~59/60
 * of the time and its row might never be written in a session. Each caller
 * surface persists a distinct instrument-id set, so the set IS the surface
 * key; write amplification stays bounded at one write per minute per key.
 */
export const QUOTE_CACHE_WRITE_INTERVAL_MS = 60_000;

/** Distinct surfaces are few (Holdings, Watchlist, one per open ticker
 *  page); the cap only guards against a pathological caller. Oldest-insert
 *  eviction — an evicted key simply writes once more, never less. */
const MAX_THROTTLE_KEYS = 64;

const lastPersistAtMsByKey = new Map<string, number>();

/** The throttle decision, pure for the unit tests. `lastAtMs === 0` means
 *  "never persisted this instance" — a cold start writes immediately. */
export function shouldPersist(nowMs: number, lastAtMs: number): boolean {
  if (lastAtMs === 0) return true;
  return nowMs - lastAtMs >= QUOTE_CACHE_WRITE_INTERVAL_MS;
}

/** One quote worth persisting, paired with its instrument row id. */
export interface PersistableQuote {
  instrumentId: string;
  quote: Quote;
}

/** The throttle key for a surface, pure for the unit tests: the sorted,
 *  deduped instrument-id set. Order-insensitive on purpose — the same
 *  surface must map to the same key regardless of row iteration order.
 *
 *  Derived from the REQUESTED ids, never from the successfully-quoted subset
 *  (2026-08-16 delta-scan fix). Under a vendor flap the per-chunk failures
 *  alternate which symbols come back, so a subset-derived key would mint a
 *  cold key on nearly every poll and write on every 10 s tick — precisely the
 *  amplification this window exists to stop. The requested set is stable per
 *  surface whether the vendor answers or not. */
export function persistThrottleKey(instrumentIds: Iterable<string>): string {
  return [...new Set(instrumentIds)].sort().join('\n');
}

/** The insert row shape — exported for the pure mapping tests. */
export interface LatestQuoteRow {
  instrumentId: string;
  price: string;
  prevClose: string;
  currency: string;
  marketState: string;
  quoteDelayS: number;
  source: string;
  fetchedAt: Date;
}

/**
 * Quotes → insert rows, pure. A quote with a null `prevClose` is SKIPPED —
 * the column is NOT NULL (schema.ts) and a cache row is optional by nature,
 * so skipping beats fabricating a baseline or altering the column. Currency
 * is stamped `'USD'` exactly as the live path stamps it (Massive is
 * US-markets-only by construction). Money stays decimal strings end to end;
 * `toNumeric(dec(...))` is the same numeric(20,8) serialization every other
 * writer uses.
 */
export function toLatestQuoteRows(
  entries: readonly PersistableQuote[],
  now: Date,
): LatestQuoteRow[] {
  const rows: LatestQuoteRow[] = [];
  for (const { instrumentId, quote } of entries) {
    if (quote.prevClose === null) continue;
    rows.push({
      instrumentId,
      price: toNumeric(dec(quote.price), 8),
      prevClose: toNumeric(dec(quote.prevClose), 8),
      currency: 'USD',
      marketState: quote.marketStatus,
      quoteDelayS: quote.delaySeconds,
      source: quote.source,
      fetchedAt: now,
    });
  }
  return rows;
}

/**
 * Persist a batch of good quotes — one `insert … onConflictDoUpdate` keyed on
 * `instrumentId`, behind the 60 s in-process throttle. `throttleKey` comes
 * from the caller's REQUESTED instrument-id set (`persistThrottleKey`), which
 * is what makes the window stable per surface under a partial vendor failure.
 * Never throws; callers may await it without failure semantics.
 */
export async function persistQuotes(
  entries: readonly PersistableQuote[],
  throttleKey: string,
): Promise<void> {
  if (entries.length === 0) return;
  const nowMs = Date.now();
  if (!shouldPersist(nowMs, lastPersistAtMsByKey.get(throttleKey) ?? 0)) return;

  let rows: LatestQuoteRow[];
  try {
    // Inside the try so the "never throws" contract is literally true: every
    // price reaching here has passed `decString()` at mapping time, but the
    // caller must not have to know that.
    rows = toLatestQuoteRows(entries, new Date(nowMs));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'quote cache mapping failed';
    console.error(`Quote cache row mapping failed: ${message}`);
    return;
  }
  if (rows.length === 0) return;

  try {
    await db
      .insert(latestQuotes)
      .values(rows)
      .onConflictDoUpdate({
        target: latestQuotes.instrumentId,
        set: {
          price: sql`excluded.price`,
          prevClose: sql`excluded.prev_close`,
          currency: sql`excluded.currency`,
          marketState: sql`excluded.market_state`,
          quoteDelayS: sql`excluded.quote_delay_s`,
          source: sql`excluded.source`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
    // Stamped only after a successful write: a failed attempt should retry on
    // the next poll, not sit out the whole window.
    if (lastPersistAtMsByKey.size >= MAX_THROTTLE_KEYS && !lastPersistAtMsByKey.has(throttleKey)) {
      const oldest = lastPersistAtMsByKey.keys().next().value;
      if (oldest !== undefined) lastPersistAtMsByKey.delete(oldest);
    }
    lastPersistAtMsByKey.set(throttleKey, nowMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'quote cache write failed';
    console.error(`Quote cache write failed (${rows.length} rows): ${message}`);
  }
}

/** What a cached row yields for display: price + currency + the FETCH time
 *  (labelled as such downstream — never presented as a trade time). */
export interface CachedQuote {
  price: string;
  currency: string;
  fetchedAtMs: number;
}

/** A stored row → the display entry, pure — `dec()` re-normalisation so
 *  numeric(20,8) padding never leaks ('231.59000000' → '231.59'). */
export function toCachedQuote(row: {
  price: string;
  currency: string;
  fetchedAt: Date;
}): CachedQuote {
  return {
    price: dec(row.price).toString(),
    currency: row.currency.trim(),
    fetchedAtMs: row.fetchedAt.getTime(),
  };
}

/**
 * Cached quotes for a symbol → instrumentId reference map, keyed back by
 * symbol. Best-effort: any failure returns the empty map and logs — the
 * caller renders dashes exactly as before the cache existed.
 */
export async function readCachedQuotes(
  refs: ReadonlyMap<string, string>,
): Promise<Map<string, CachedQuote>> {
  const cached = new Map<string, CachedQuote>();
  if (refs.size === 0) return cached;

  try {
    const ids = [...new Set(refs.values())];
    const rows = await db
      .select({
        instrumentId: latestQuotes.instrumentId,
        price: latestQuotes.price,
        currency: latestQuotes.currency,
        fetchedAt: latestQuotes.fetchedAt,
      })
      .from(latestQuotes)
      .where(inArray(latestQuotes.instrumentId, ids));

    const byInstrument = new Map(rows.map((row) => [row.instrumentId, row]));
    for (const [symbol, instrumentId] of refs) {
      const row = byInstrument.get(instrumentId);
      if (row !== undefined) cached.set(symbol, toCachedQuote(row));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'quote cache read failed';
    console.error(`Quote cache read failed: ${message}`);
  }
  return cached;
}

/**
 * The newest `fetched_at` across the cache — the Settings health surface's
 * "last price fetched" line. Null on an empty cache or any failure.
 */
export async function newestFetchedAt(): Promise<Date | null> {
  try {
    const [row] = await db.select({ newest: max(latestQuotes.fetchedAt) }).from(latestQuotes);
    return row?.newest ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'quote cache read failed';
    console.error(`Quote cache newest-fetch read failed: ${message}`);
    return null;
  }
}

/** Test-only: reset the in-process throttle between cases. */
export function resetQuoteCacheThrottleForTests(): void {
  lastPersistAtMsByKey.clear();
}
