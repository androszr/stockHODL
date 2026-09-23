import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import { db, instruments, watchlist } from '@/lib/db';
import { resolveOrCreateInstrument } from '@/lib/instruments/resolve';
import type { TrendSlot } from '@/lib/trend/day-trend';
import { fetchTrendsBestEffort } from '@/lib/trend/load';
import type { WatchlistAddInput } from '@/lib/validation';

/**
 * Watchlist reads and writes, owned here rather than in the Server Action.
 *
 * Same discipline as the transaction path: the user id is an argument the
 * caller derived from a session, and every row written or deleted is scoped
 * to it. Instruments are minted through the shared `resolveOrCreateInstrument`
 * path — the same first-write-wins + currency-mismatch refusal the
 * transaction form uses.
 */

export type WatchlistMutation = { ok: true } | { ok: false; error: string };

export interface WatchedRow {
  instrumentId: string;
  symbol: string;
  displayName: string;
  currency: string;
  /**
   * The five-day trend strip, oldest session first. Absent for a stock added
   * moments ago, whose history the nightly cron has not stored yet — the tile
   * reserves the space and draws nothing, which is the honest state.
   */
  trend?: TrendSlot[];
}

/** Insertion-ordered (oldest watch first) — the only ordering for now. */
export async function listWatchlist(userId: string): Promise<WatchedRow[]> {
  const rows = await db
    .select({
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      currency: instruments.currency,
    })
    .from(watchlist)
    .innerJoin(instruments, eq(watchlist.instrumentId, instruments.id))
    .where(eq(watchlist.userId, userId))
    .orderBy(asc(watchlist.createdAt));

  // Sequential rather than concurrent with the list above: the ids come FROM
  // that list. Best-effort by contract — a history outage costs the strips and
  // leaves the watchlist itself intact (`fetchTrendsBestEffort` never throws).
  const trends = await fetchTrendsBestEffort(rows.map((r) => r.instrumentId));
  return rows.map((row) => ({ ...row, trend: trends.get(row.instrumentId) }));
}

export async function addToWatchlist(
  userId: string,
  input: WatchlistAddInput,
): Promise<WatchlistMutation> {
  const instrument = await resolveOrCreateInstrument(input);
  if (!instrument.ok) return { ok: false, error: instrument.error };

  // Idempotent on the composite PK: re-adding an already-watched stock is a
  // no-op, never an error — the tile is simply already there.
  await db
    .insert(watchlist)
    .values({ userId, instrumentId: instrument.id })
    .onConflictDoNothing({ target: [watchlist.userId, watchlist.instrumentId] });

  return { ok: true };
}

/**
 * Scoped delete. A foreign or unknown id deletes nothing and still reports
 * ok — removal is idempotent by decision (unlike a transaction delete, an
 * absent watch row IS the requested end state), and nothing is enumerable.
 */
export async function removeFromWatchlist(
  userId: string,
  instrumentId: string,
): Promise<WatchlistMutation> {
  await db
    .delete(watchlist)
    .where(and(eq(watchlist.userId, userId), eq(watchlist.instrumentId, instrumentId)));

  return { ok: true };
}
