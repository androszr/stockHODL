import { massiveProvider } from '@/lib/market-data/massive';
import {
  hasExactSymbolMatch,
  MAX_EXACT_TICKER_LENGTH,
  mergeSymbolMatches,
} from '@/lib/market-data/nasdaq-directory';
import { searchSymbolDirectory } from '@/lib/market-data/symbol-directory';
import {
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_RESULTS,
  type SymbolMatch,
} from '@/lib/market-data/symbol-search';

/**
 * The symbol search itself, extracted from `/api/symbols/search` when the
 * native client needed the same answer through a bearer-authenticated door
 * (stage C4).
 *
 * It lives here rather than being called route-to-route for the reason every
 * other mobile twin does: `src/proxy.ts` is a COOKIE gate whose only exclusion
 * is `/api/mobile/`, so the phone cannot reach the web route at all — it would
 * be redirected to `/login` and try to decode an HTML page as JSON. Two thin
 * handlers over one shared body is the arrangement that cannot drift; widening
 * the proxy's exclusion list to save a file would trade a documented
 * deny-by-default boundary for nothing.
 *
 * Everything below is the web route's original logic, unchanged:
 *
 * Massive-first: the paid provider is asked before anything else. When it is
 * degraded (down, bad key, timeout) OR simply returns zero results, the local
 * US symbol directory (our own table, refreshed daily) answers instead — it
 * covers provider outages and indexing gaps alike. `degraded: true` is only
 * reported when the provider failed AND the directory had nothing: that flag
 * tells the client "search is broken, use manual entry", which would be a lie
 * while the fallback still works.
 *
 * Exact-ticker guarantee: the provider matches ticker OR name inside a
 * bounded, ticker-ascending result window, so a short query that is itself a
 * ticker ("GO", "ON", "AM") can have every slot taken by alphabetically
 * earlier NAME matches — the exact ticker never reaches the ranker at all.
 * When a short query has no exact hit in the provider's results, the local
 * directory (whose SQL ranking can never lose an exact match) is consulted
 * too and both sources merge through the shared ranker.
 *
 * The client never talks to any market-data vendor — the two routes over this
 * function are the only doors, and the upstream URL is a constant with the
 * query carried solely via URLSearchParams (no SSRF surface).
 */

export { MAX_SEARCH_QUERY_LENGTH, MAX_SEARCH_RESULTS };

export interface SymbolSearchOutcome {
  results: SymbolMatch[];
  degraded?: true;
}

export async function searchSymbols(q: string): Promise<SymbolSearchOutcome> {
  const { results, degraded } = await massiveProvider.searchSymbols(q);

  // See the exact-ticker guarantee above: a short query without an exact hit
  // may simply mean the provider's window filled up before reaching it.
  const exactMayBeMissing =
    q.length <= MAX_EXACT_TICKER_LENGTH && !hasExactSymbolMatch(q, results);

  if (!degraded && results.length > 0 && !exactMayBeMissing) {
    return { results: results.slice(0, MAX_SEARCH_RESULTS) };
  }

  // Provider failed, knew nothing, or may have lost the exact ticker. The
  // directory returns [] (never throws) when its table is missing — the 42P01
  // degradation path. Merging with an empty provider list is a plain re-rank.
  const local = await searchSymbolDirectory(q);
  const merged = mergeSymbolMatches(q, results, local);
  if (merged.length > 0) {
    return { results: merged.slice(0, MAX_SEARCH_RESULTS) };
  }

  if (degraded) return { results: [], degraded: true };
  return { results: [] };
}
