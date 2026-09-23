import type { SymbolMatch } from './symbol-search';

/**
 * Pure parsing + ranking for the Nasdaq Trader symbol directory
 * (`nasdaqtraded.txt`). Deliberately isomorphic with no server marker — same
 * rationale as `symbol-search.ts`: it reads neither env nor the database, so
 * the unit tests can import it directly. The fetch and the DB live in
 * `symbol-directory.ts`.
 *
 * File shape (verified live 2026-08-08): pipe-delimited, ~13k lines, header
 * row first, trailing `File Creation Time: …` line last. Columns:
 *
 *   Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|
 *   Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares
 */

export interface DirectoryRow {
  /** Provider notation — class-share slashes are normalised to dots (`BRK.A`). */
  symbol: string;
  name: string;
  /** Human-readable exchange, already mapped from the one-letter code. */
  exchange: string;
  type: 'equity' | 'etf';
}

/**
 * `Listing Exchange` codes → display names. Conservative on purpose: an
 * unknown code drops the row rather than shipping a cryptic letter into the
 * transaction form.
 */
const EXCHANGE_NAMES: Record<string, string> = {
  N: 'NYSE',
  Q: 'Nasdaq',
  A: 'NYSE American',
  P: 'NYSE Arca',
  Z: 'Cboe BZX',
  V: 'IEX',
};

/**
 * Nasdaq Trader spells class shares with a slash (`BRK/A`); the quote provider
 * uses the dot convention (`BRK.A`). `instruments` is first-write-wins, so a
 * symbol bound from a directory search must be spelled the way `getQuotes`
 * will later request it — otherwise the instrument answers `not_found`
 * forever. Applied at every `DirectoryRow` boundary: when parsing the file
 * and when reading rows persisted before this rule existed.
 */
export function normalizeDirectorySymbol(symbol: string): string {
  return symbol.replaceAll('/', '.');
}

/**
 * The inverse crossing, for exact-symbol LOOKUPS against the stored table:
 * rows persisted before the slash→dot rule may still carry the file's
 * `BRK/A` spelling until the next daily refresh rewrites them, so an exact
 * match on a provider-notation symbol must also try the legacy slash form.
 * A no-op on symbols without a class-share separator (`AAPL`).
 */
export function denormalizeDirectorySymbol(symbol: string): string {
  return symbol.replaceAll('.', '/');
}

const COL_SYMBOL = 1;
const COL_NAME = 2;
const COL_EXCHANGE = 3;
const COL_ETF = 5;
const COL_TEST_ISSUE = 7;
/** A data row has all 12 columns; short lines are trailer/garbage. */
const MIN_COLUMNS = 8;

export function parseNasdaqDirectory(text: string): DirectoryRow[] {
  const rows: DirectoryRow[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue; // tolerate the blank final line
    if (line.startsWith('Nasdaq Traded|')) continue; // header row
    if (line.startsWith('File Creation Time')) continue; // trailer line

    const cols = line.split('|');
    if (cols.length < MIN_COLUMNS) continue;

    const symbol = cols[COL_SYMBOL].trim();
    const name = cols[COL_NAME].trim();
    if (!symbol || !name) continue;
    if (cols[COL_TEST_ISSUE].trim() === 'Y') continue;

    const exchange = EXCHANGE_NAMES[cols[COL_EXCHANGE].trim()];
    if (!exchange) continue;

    rows.push({
      symbol: normalizeDirectorySymbol(symbol),
      name,
      exchange,
      type: cols[COL_ETF].trim() === 'Y' ? 'etf' : 'equity',
    });
  }

  return rows;
}

/**
 * Escapes SQL LIKE/ILIKE metacharacters so a user query is always a literal.
 * Drizzle parameterises the *value*, but `%`/`_` inside it would still act as
 * wildcards — `q = "%"` must not match the whole directory. Lives here (pure)
 * so it is unit-testable; `symbol-directory.ts` applies it.
 */
export function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Ranks directory rows against a query: exact symbol match first, then
 * symbol-prefix, then name-substring; ties keep alphabetical symbol order.
 * Case-insensitive, and the query is treated as a literal — `%`/`_` never act
 * as wildcards at this layer. Rows matching none of the three buckets are
 * dropped (the SQL candidate fetch is broader than the final ranking).
 *
 * Emits `SymbolMatch` so `/api/symbols/search` keeps its response shape: the
 * directory has no vendor exchange *code*, so `exchange` carries the display
 * name too, and every US listing is USD by definition of the source file.
 */
export function rankDirectoryMatches(
  query: string,
  rows: readonly DirectoryRow[],
): SymbolMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  const exact: DirectoryRow[] = [];
  const prefix: DirectoryRow[] = [];
  const nameSub: DirectoryRow[] = [];

  for (const row of rows) {
    const symbol = row.symbol.toLowerCase();
    if (symbol === q) exact.push(row);
    else if (symbol.startsWith(q)) prefix.push(row);
    else if (row.name.toLowerCase().includes(q)) nameSub.push(row);
  }

  const bySymbol = (a: DirectoryRow, b: DirectoryRow) =>
    a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  prefix.sort(bySymbol);
  nameSub.sort(bySymbol);

  return [...exact, ...prefix, ...nameSub].map((row) => ({
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    exchangeDisplay: row.exchange,
    type: row.type,
    currency: 'USD',
  }));
}

/**
 * US tickers run 1–5 characters — the range where "this query IS a ticker" is
 * a live possibility that result ranking must never lose.
 */
export const MAX_EXACT_TICKER_LENGTH = 5;

/** True when any match's symbol equals the query, case-insensitively. */
export function hasExactSymbolMatch(
  query: string,
  matches: readonly SymbolMatch[],
): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return false;
  return matches.some((m) => m.symbol.toLowerCase() === q);
}

/**
 * Merges provider results with local-directory results through the one shared
 * ranker, so an exact ticker the provider's bounded result window omitted can
 * still surface from the directory. Dedupe is by uppercase symbol with the
 * provider entry winning (its listing metadata is fresher); ordering is
 * decided solely by `rankDirectoryMatches` — source never outranks relevance.
 */
export function mergeSymbolMatches(
  query: string,
  primary: readonly SymbolMatch[],
  fallback: readonly SymbolMatch[],
): SymbolMatch[] {
  const seen = new Set(primary.map((m) => m.symbol.toUpperCase()));
  const rows: DirectoryRow[] = [
    ...primary,
    ...fallback.filter((m) => !seen.has(m.symbol.toUpperCase())),
  ].map((m) => ({ symbol: m.symbol, name: m.name, exchange: m.exchange, type: m.type }));
  return rankDirectoryMatches(query, rows);
}
