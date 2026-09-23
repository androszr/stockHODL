/**
 * The news symbol union — pure, no server marker (reads neither env nor the
 * database), so the unit tests import it directly.
 *
 * The union is every symbol the user "knows": watched, held, and option
 * underlyings, in that PRIORITY order. The refresh asks the vendor ONE
 * request per symbol (the only form its ticker filter honors — verified live
 * 2026-08-16), which cannot be unbounded — so the union is capped, and the
 * `MAX_BACKFILL_SYMBOLS` / `excludedSymbols` discipline applies: overflow is
 * NAMED in `omitted`, never silently dropped, so the UI can say which
 * companies were left out.
 */

/**
 * Cap on the per-refresh symbol set — one vendor request per symbol per
 * refresh, so this bounds the request count. 50 comfortably clears any
 * plausible personal watchlist + portfolio while keeping a full refresh to
 * at most 50 bounded-concurrency requests.
 */
export const MAX_NEWS_SYMBOLS = 50;

export interface NewsSymbolSources {
  /** Watched symbols, highest priority — this is the Watchlist's module. */
  watched: readonly string[];
  /** Symbols with open positions (quantity > 0). */
  held: readonly string[];
  /** Distinct option underlyings. */
  optionUnderlyings: readonly string[];
}

export interface NewsSymbolUnion {
  /** Uppercased, deduped, priority-ordered, at most {@link MAX_NEWS_SYMBOLS}. */
  symbols: string[];
  /** Symbols the cap pushed out — named so the UI never drops them silently. */
  omitted: string[];
}

/**
 * Dedupe across the three sources (case-insensitively — the vendor and the
 * join table both speak uppercase), keep priority order watched → held →
 * underlyings, and cap at {@link MAX_NEWS_SYMBOLS} with the overflow named.
 */
export function buildNewsSymbolUnion(sources: NewsSymbolSources): NewsSymbolUnion {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const list of [sources.watched, sources.held, sources.optionUnderlyings]) {
    for (const raw of list) {
      const symbol = raw.trim().toUpperCase();
      if (symbol === '' || seen.has(symbol)) continue;
      seen.add(symbol);
      ordered.push(symbol);
    }
  }

  return {
    symbols: ordered.slice(0, MAX_NEWS_SYMBOLS),
    omitted: ordered.slice(MAX_NEWS_SYMBOLS),
  };
}

/**
 * The per-ticker eligibility sources — the union's three, plus one that is
 * DELIBERATELY wider: symbols the user has ever transacted, open or
 * closed-out. `/holdings/[ticker]`'s owned branch renders for ANY symbol
 * with transaction history (a fully-sold position still gets its page, and
 * the transaction actions redirect there after an edit or delete), so a
 * page about a stock the user used to own is a legitimate news surface.
 * `buildNewsSymbolUnion` never reads this field: the union feed — and its
 * {@link MAX_NEWS_SYMBOLS} cap — stays current holdings + watched + option
 * underlyings, and must not absorb every symbol ever traded.
 */
export interface KnownSymbolSources extends NewsSymbolSources {
  /** Symbols with ANY transaction history, regardless of open quantity. */
  transacted?: readonly string[];
}

/**
 * Authorization gate for per-ticker news: a candidate symbol resolves iff it
 * appears (case-insensitively) somewhere in the user's own sources — watched,
 * held, an option underlying, or (per {@link KnownSymbolSources}) ever
 * transacted. Anything else — unknown ticker, foreign ticker, gibberish,
 * empty string — is `null`, indistinguishably, so no caller can turn
 * per-ticker news into an arbitrary-symbol vendor query or an existence
 * oracle. Returns the NORMALIZED (trimmed, uppercased) symbol, which is the
 * notation the join table and the vendor both speak.
 */
export function resolveKnownSymbol(
  candidate: string,
  sources: KnownSymbolSources,
): string | null {
  const symbol = candidate.trim().toUpperCase();
  if (symbol === '') return null;

  const lists = [
    sources.watched,
    sources.held,
    sources.optionUnderlyings,
    sources.transacted ?? [],
  ];
  for (const list of lists) {
    for (const raw of list) {
      if (raw.trim().toUpperCase() === symbol) return symbol;
    }
  }
  return null;
}
