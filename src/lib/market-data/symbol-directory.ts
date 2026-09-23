import 'server-only';

import { asc, eq, ilike, lt, or, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { symbolDirectory } from '@/lib/db/schema';

import {
  denormalizeDirectorySymbol,
  escapeLikePattern,
  normalizeDirectorySymbol,
  parseNasdaqDirectory,
  rankDirectoryMatches,
  type DirectoryRow,
} from './nasdaq-directory';
import type { SymbolMatch } from './symbol-search';

/**
 * The local symbol directory: bulk refresh from Nasdaq Trader, and the
 * offline fallback `/api/symbols/search` consults when the Massive provider
 * is degraded or knows nothing. Server-only — it holds the DB and the
 * upstream fetch.
 */

const DIRECTORY_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt';

/** The file is ~1 MB; generous, but a hung fetch must not wedge the cron. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Neon HTTP is one round-trip per query — 13k single-row inserts would be
 * pathological. 1000-row multi-inserts keep it to ~14 round-trips.
 */
const CHUNK_SIZE = 1000;

/**
 * SQL fetches candidates (symbol-prefix OR name-substring) ALREADY ranked —
 * exact symbol first, then symbol-prefix, then shorter symbols, then
 * alphabetical — so the LIMIT can never truncate away the best match.
 * Ranking must happen in SQL: short queries like `F` or `MS` match hundreds
 * of rows, and an unordered LIMIT hands `rankDirectoryMatches` an arbitrary
 * subset that usually omits the exact ticker. 50 comfortably covers the 8
 * results the route returns.
 */
const MAX_CANDIDATES = 50;

/**
 * Sanity floor for a refresh. The real file currently parses to ~13,080 rows;
 * a well-framed but truncated 200 response (say, 100 valid rows) would upsert
 * those few and then PRUNE the other ~13k as "untouched this run". US listings
 * will not shrink below 5,000 overnight, so anything under that is a broken
 * download — refuse to sync, keep the existing rows, and let the cron report
 * the failure.
 */
const MIN_DIRECTORY_ROWS = 5000;

/**
 * Postgres `undefined_table`. Between deploying this code and applying the
 * migration (or in an environment that never migrated), the table may not
 * exist — that must degrade to "no local match" (provider-only behaviour),
 * never a 500 on the search route.
 */
const UNDEFINED_TABLE = '42P01';

function isUndefinedTable(error: unknown): boolean {
  // Drizzle wraps driver errors (DrizzleQueryError), so the Postgres code sits
  // on `.cause`, not the top level — walk the chain, bounded against cycles.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === UNDEFINED_TABLE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Re-downloads the full directory and syncs the table: chunked upserts stamped
 * with the run start, then a prune of every row the run did not touch
 * (delistings). No transaction on Neon HTTP — a crash between the two phases
 * leaves stale rows until the next daily run, which is acceptable; keying the
 * prune off the run-start timestamp guarantees it never deletes fresh rows.
 */
export async function refreshSymbolDirectory(): Promise<{ upserted: number; deleted: number }> {
  const runStart = new Date();

  const response = await fetch(DIRECTORY_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Symbol directory fetch failed: HTTP ${response.status}`);
  }

  const parsed = parseNasdaqDirectory(await response.text());
  // An empty, unparseable, or drastically truncated file must never trigger
  // the prune — that would wipe most of the directory because "nothing was
  // touched this run". See MIN_DIRECTORY_ROWS.
  if (parsed.length < MIN_DIRECTORY_ROWS) {
    throw new Error(
      `Symbol directory parsed to ${parsed.length} rows (floor ${MIN_DIRECTORY_ROWS}) — refusing to sync`,
    );
  }

  // De-duplicate by symbol (last row wins). A repeated symbol inside one
  // upsert chunk would abort it with Postgres's "ON CONFLICT DO UPDATE cannot
  // affect row a second time" — latent today (the file has no duplicates),
  // but one bad upstream file must not fail the whole refresh.
  const rows = [...new Map(parsed.map((row) => [row.symbol, row])).values()];

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    await db
      .insert(symbolDirectory)
      .values(chunk.map((row) => ({ ...row, updatedAt: runStart })))
      .onConflictDoUpdate({
        target: symbolDirectory.symbol,
        set: {
          name: sql`excluded.name`,
          exchange: sql`excluded.exchange`,
          type: sql`excluded.type`,
          updatedAt: runStart,
        },
      });
  }

  const deleted = await db
    .delete(symbolDirectory)
    .where(lt(symbolDirectory.updatedAt, runStart))
    .returning({ symbol: symbolDirectory.symbol });

  return { upserted: rows.length, deleted: deleted.length };
}

/**
 * Exact-symbol lookup — the ticker page's "is this a US listing?" question
 * (options-underlying branch, 2026-08-17). Matches BOTH notations: the
 * provider dot form callers hold (`BRK.A`) and the legacy slash form
 * (`BRK/A`) rows persisted before the slash→dot rule may still carry. Both
 * are bound parameters — never interpolated. Never throws on the page path:
 * a missing table degrades to `null` (same rationale as the search below),
 * and any other failure is logged and answered `null` — the caller renders
 * the degraded view, never a 500.
 */
export async function lookupDirectorySymbol(
  symbol: string,
): Promise<{ name: string; exchange: string } | null> {
  const s = symbol.trim();
  if (s.length === 0) return null;

  try {
    const [row] = await db
      .select({ name: symbolDirectory.name, exchange: symbolDirectory.exchange })
      .from(symbolDirectory)
      .where(
        or(
          eq(symbolDirectory.symbol, s),
          eq(symbolDirectory.symbol, denormalizeDirectorySymbol(s)),
        ),
      )
      .limit(1);
    return row ?? null;
  } catch (error) {
    if (!isUndefinedTable(error)) {
      const message = error instanceof Error ? error.message : 'directory lookup failed';
      console.error(`Symbol directory lookup failed (${s}): ${message}`);
    }
    return null;
  }
}

/**
 * Local fallback search. The query value is parameterised by Drizzle and its
 * LIKE metacharacters are escaped first, so `%` cannot match the whole table.
 * Every `sql` fragment below carries the query as a bound parameter — the
 * user's string is never interpolated into SQL text. Returns `[]` (never
 * throws) when the table is missing, so the route degrades to provider-only
 * results exactly as before this table existed.
 */
export async function searchSymbolDirectory(query: string): Promise<SymbolMatch[]> {
  const q = query.trim();
  if (q.length === 0) return [];

  const escaped = escapeLikePattern(q);
  const prefixPattern = `${escaped}%`;

  let candidates: (typeof symbolDirectory.$inferSelect)[];
  try {
    candidates = await db
      .select()
      .from(symbolDirectory)
      .where(
        or(
          ilike(symbolDirectory.symbol, prefixPattern),
          ilike(symbolDirectory.name, `%${escaped}%`),
        ),
      )
      .orderBy(
        // Exact ticker beats everything, then ticker-prefix beats name-only;
        // booleans sort true-first under DESC. Shorter symbols next (`F` above
        // `FAT` for query `F`), alphabetical last for a stable total order.
        sql`(lower(${symbolDirectory.symbol}) = lower(${q})) DESC`,
        sql`(${symbolDirectory.symbol} ILIKE ${prefixPattern}) DESC`,
        sql`length(${symbolDirectory.symbol}) ASC`,
        asc(symbolDirectory.symbol),
      )
      .limit(MAX_CANDIDATES);
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }

  const rows: DirectoryRow[] = candidates.map((c) => ({
    // Rows persisted before the slash→dot rule may still carry `BRK/A` until
    // the next daily refresh rewrites them — normalize on the way out so the
    // provider convention is the only one that ever leaves this module.
    symbol: normalizeDirectorySymbol(c.symbol),
    name: c.name,
    exchange: c.exchange,
    type: c.type === 'etf' ? 'etf' : 'equity',
  }));

  return rankDirectoryMatches(q, rows);
}
