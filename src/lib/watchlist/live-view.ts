import 'server-only';

import { asc, eq } from 'drizzle-orm';

import { loadTargetLinesByInstrument } from '@/lib/alerts/target-store';
import { db, instruments, watchlist } from '@/lib/db';
import {
  fetchMarketStatusBestEffort,
  fetchQuotesBestEffort,
} from '@/lib/holdings/live-view';
import type { HoldingQuote } from '@/lib/holdings/live-payload';

import type { WatchlistInputs } from './watchlist-payload';

/**
 * The Watchlist LOADER — the one data walk the page (initial render),
 * `GET /api/quotes/watchlist` (the 10 s poll) and
 * `GET /api/quotes/watchlist/stream` (the SSE baseline) all run. The exact
 * shape of `loadHoldingsInputs`, minus everything positional: no engine, no
 * FX (tiles show native-currency prices only), no transactions join.
 *
 * DELIBERATELY PARALLEL to the Holdings walk, never merged into it: watched
 * symbols must not widen the Holdings/Dashboard vendor batch, socket
 * subscription or payload. The shared pieces (`fetchQuotesBestEffort`,
 * `fetchMarketStatusBestEffort`) are the extracted best-effort fetchers, so
 * vendor discipline stays single-sourced.
 */

/** One watched row's static identity — ships with the page, not the payload. */
export interface WatchedItem {
  instrumentId: string;
  symbol: string;
  displayName: string;
  /** Instrument trading currency, for the quote guard. */
  currency: string;
}

export interface LoadedWatchlist {
  /** Insertion-ordered (oldest watch first) — the only ordering for now. */
  items: WatchedItem[];
  inputs: WatchlistInputs;
  quotes: Map<string, HoldingQuote>;
}

export async function loadWatchlistInputs(userId: string): Promise<LoadedWatchlist> {
  const items = await db
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

  // Refs opt the watched quotes into the durable quote cache — WRITE-only
  // here by scope (2026-08-16, massive-tier0 plan): the watchlist rows do not
  // render cached prices yet, but their good quotes still persist so a later
  // failure has something saved to show elsewhere.
  const symbols = [...new Set(items.map((i) => i.symbol))];
  const refs = new Map(items.map((i) => [i.symbol, i.instrumentId]));
  // Target lines ride on the INPUTS, loaded once per walk — the stream
  // recomposes from these on every tick, so the list and its live updates
  // agree about the grouping by construction (a line added mid-stream lands
  // on the next refresh/reconnect, stated in the plan's manual criteria).
  const [{ quotes, pollable }, market, targetsByInstrument] = await Promise.all([
    fetchQuotesBestEffort(symbols, refs),
    fetchMarketStatusBestEffort(),
    loadTargetLinesByInstrument(userId),
  ]);

  return {
    items,
    inputs: { market, hasPollableSymbols: pollable, targetsByInstrument },
    quotes,
  };
}
