import 'server-only';

import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';

import {
  db,
  instruments,
  newsArticles,
  newsArticleTickers,
  optionPositions,
  portfolios,
  transactions,
  watchlist,
} from '@/lib/db';
import { getNewsArticles, isServablePublisherAssetUrl } from '@/lib/market-data/massive';
import type { NewsArticle } from '@/lib/market-data/massive-mapping';
import { computePositions, type EngineTransaction } from '@/lib/position-engine';

import { persistArticles, pruneOldArticles } from './store';
import { parseNewsInsights } from './insights';
import { buildNewsSymbolUnion, MAX_NEWS_SYMBOLS, resolveKnownSymbol } from './symbol-union';

/**
 * The ONE news loader — the Watchlist section, the `/news` list and the
 * `/news/[id]` detail page all read through here. The walk: compute the
 * user's symbol union (watched → held → option underlyings, capped with the
 * overflow NAMED), refresh the store from the vendor — ONE request per
 * symbol under bounded concurrency, the only request shape the vendor's
 * ticker filter actually honors (verified live 2026-08-16; every
 * multi-symbol parameter form is silently ignored) — through an in-process
 * TTL, then serve the feed FROM THE DATABASE — never from the vendor
 * response directly, so what the feed shows is exactly what the detail page
 * can re-serve (the vendor has no fetch-by-id; the rows are the identity
 * source).
 *
 * Failure discipline at the page boundary: NOTHING here throws. Per-symbol
 * vendor failures degrade to the persisted rows, with `degraded: true` only
 * past {@link NEWS_DEGRADED_FAILURE_RATIO} (or on a failed store write — the
 * rows are what the feed reads, so a lost write is as absent as a failed
 * fetch); a database failure degrades to an empty, degraded feed. Logs carry
 * a message only — never a key or URL.
 */

/** Ask the vendor at most this often per symbol set, per instance —
 *  best-effort on serverless (evaporates on cold start), fine at
 *  unlimited REST and exactly one user. */
const NEWS_TTL_MS = 5 * 60 * 1000;

/** A failed refresh retries sooner — but never on every render, or a vendor
 *  outage would put a 5 s timeout in front of every Watchlist visit
 *  (the `CALENDAR_DEGRADED_TTL_MS` rationale). */
const NEWS_DEGRADED_TTL_MS = 60 * 1000;

/** Stories asked for per SYMBOL per refresh. 10 matches the vendor's
 *  observed page size, is 2× `TICKER_NEWS_THIN_THRESHOLD`, and bounds a full
 *  50-symbol refresh at ≤ 500 rows before id-dedup — the 50-item `/news`
 *  page fills from the DATABASE, which accumulates across refresh cycles
 *  under 90-day retention, so no single fetch needs to fill it. */
const NEWS_PER_SYMBOL_LIMIT = 10;

/** Vendor requests per refresh, capped defensively at the union cap — the
 *  union layer already enforces it upstream (with overflow NAMED in
 *  `omitted`), but the invariant is re-imposed locally. */
const NEWS_MAX_REQUESTS_PER_REFRESH = MAX_NEWS_SYMBOLS;

/** Fan-out lanes — never 50 sockets at once at the vendor (the
 *  `fetchAggregates` don't-`Promise.all`-large-sets discipline). Typical
 *  refresh: 50 symbols / 5 lanes ≈ 10 waves ≈ 2–4 s. */
const NEWS_REFRESH_CONCURRENCY = 5;

/** Degraded iff `failed / attempted` strictly exceeds this — 1–2 flaky
 *  symbols out of 50 keep serving stored rows without a scary banner; past
 *  one-in-five missing, the feed is materially misleading and says so. A
 *  single-symbol refresh that fails is 1/1 > 0.2 → degraded, preserving the
 *  per-ticker semantics. */
const NEWS_DEGRADED_FAILURE_RATIO = 0.2;

/** 40, not 20: per-ticker refreshes (`loadTickerNews`) key this map by the
 *  single symbol, sharing it with the union key — at 20, a browsing session
 *  touching ~20 instrument pages would evict the union entry and make the
 *  Watchlist re-ask the vendor. */
const MAX_REFRESH_CACHE_ENTRIES = 40;

/** Section size on the instrument/contract pages — a per-ticker read below
 *  this triggers one TTL-gated vendor refresh before re-reading. */
const TICKER_NEWS_THIN_THRESHOLD = 5;

interface RefreshCacheEntry {
  at: number;
  ttlMs: number;
  /** The last refresh attempt within this TTL window failed. */
  degraded: boolean;
}

/** Keyed by the sorted symbol set — insertion order doubles as eviction order. */
const refreshCache = new Map<string, RefreshCacheEntry>();

export interface NewsFeedItem {
  id: string;
  title: string;
  publisherName: string | null;
  /** Epoch ms — formatted device-local in the client (`PublishedAt`). */
  publishedAtMs: number;
  /** Whether a hero image exists; the URL itself never reaches the client. */
  hasImage: boolean;
  /** Whether a stored publisher logo/favicon URL can plausibly SERVE — the
   *  `hasImage` precedent (the card renders `/api/news/publisher-logo/<id>`,
   *  the URL itself never reaches the client), gated through
   *  `isServablePublisherAssetUrl` so an svg-only or off-origin publisher
   *  renders name-only instead of a permanently-404ing box (2026-08-16 gap
   *  fix). Pre-existing rows are false. */
  hasPublisherLogo: boolean;
  /** Article tickers ∩ the user's union (a per-ticker read also counts its
   *  own resolved symbol) — every card names ≥ 1 of these. */
  matchedTickers: string[];
}

export interface NewsFeed {
  articles: NewsFeedItem[];
  /** Union symbols the cap pushed out — the section names them honestly. */
  omitted: string[];
  /** The freshest refresh attempt failed; rows may be stale. */
  degraded: boolean;
}

export interface DayHeadline extends NewsFeedItem {
  sentimentByTicker: Record<string, string | null>;
  description: string | null;
  /** The article page — what the day-report writer opens with web_fetch. */
  articleUrl: string;
}

/** Stored headlines in a bounded window, intersected with the caller's own symbol union. */
export async function loadHeadlinesForSymbols(
  userId: string,
  symbols: readonly string[],
  window: { fromMs: number; toMs: number },
): Promise<DayHeadline[]> {
  try {
    const context = await loadSymbolContext(userId);
    const union = buildNewsSymbolUnion({
      watched: context.watched,
      held: context.held,
      optionUnderlyings: context.optionUnderlyings,
    });
    const allowed = new Set(union.symbols);
    const requested = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].filter((symbol) =>
      allowed.has(symbol),
    );
    if (requested.length === 0) return [];

    await refreshIfStale(requested);
    const matchingIds = db
      .select({ articleId: newsArticleTickers.articleId })
      .from(newsArticleTickers)
      .where(inArray(newsArticleTickers.ticker, requested));
    const rows = await db
      .select({
        id: newsArticles.id,
        title: newsArticles.title,
        publisherName: newsArticles.publisherName,
        publishedAt: newsArticles.publishedAt,
        description: newsArticles.description,
        articleUrl: newsArticles.articleUrl,
        insights: newsArticles.insights,
        imageUrl: newsArticles.imageUrl,
        publisherLogoUrl: newsArticles.publisherLogoUrl,
        publisherFaviconUrl: newsArticles.publisherFaviconUrl,
      })
      .from(newsArticles)
      .where(
        and(
          inArray(newsArticles.id, matchingIds),
          gte(newsArticles.publishedAt, new Date(window.fromMs)),
          lte(newsArticles.publishedAt, new Date(window.toMs)),
        ),
      )
      .orderBy(desc(newsArticles.publishedAt));

    const matchedById = new Map<string, string[]>();
    if (rows.length > 0) {
      const joins = await db
        .select({ articleId: newsArticleTickers.articleId, ticker: newsArticleTickers.ticker })
        .from(newsArticleTickers)
        .where(inArray(newsArticleTickers.articleId, rows.map((row) => row.id)))
        .orderBy(asc(newsArticleTickers.ticker));
      const requestedSet = new Set(requested);
      for (const join of joins) {
        if (!requestedSet.has(join.ticker)) continue;
        const list = matchedById.get(join.articleId);
        if (list) list.push(join.ticker);
        else matchedById.set(join.articleId, [join.ticker]);
      }
    }

    return rows.map((row) => {
      const sentiments = Object.fromEntries(
        parseNewsInsights(row.insights).map((insight) => [insight.ticker, insight.sentiment]),
      );
      return {
        id: row.id,
        title: row.title,
        publisherName: row.publisherName,
        publishedAtMs: row.publishedAt.getTime(),
        hasImage: row.imageUrl !== null,
        hasPublisherLogo:
          isServablePublisherAssetUrl(row.publisherLogoUrl) ||
          isServablePublisherAssetUrl(row.publisherFaviconUrl),
        matchedTickers: matchedById.get(row.id) ?? [],
        sentimentByTicker: sentiments,
        description: row.description,
        articleUrl: row.articleUrl,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'day headline load failed';
    console.error(`Day report headlines failed: ${message}`);
    return [];
  }
}

export interface NewsArticleDetail {
  id: string;
  title: string;
  author: string | null;
  publisherName: string | null;
  publisherHomepage: string | null;
  /** Epoch ms — formatted device-local in the client. */
  publishedAtMs: number;
  articleUrl: string;
  hasImage: boolean;
  description: string | null;
  /** jsonb verbatim — parsed defensively at render (`parseNewsKeywords`). */
  keywords: unknown;
  /** jsonb verbatim — parsed defensively at render (`parseNewsInsights`). */
  insights: unknown;
  /** Every ticker the vendor tagged, alphabetical. */
  tickers: string[];
  /** The subset of `tickers` that may link to `/holdings/[ticker]` —
   *  watched or held only (that route 404s for anything else by design). */
  linkableTickers: string[];
}

interface SymbolContext {
  watched: string[];
  held: string[];
  optionUnderlyings: string[];
  /** Every symbol with ANY transaction history, open or closed-out — the
   *  per-ticker eligibility widening (`KnownSymbolSources.transacted`).
   *  NEVER fed to `buildNewsSymbolUnion`: the feed and its cap stay current
   *  holdings + watched + option underlyings. */
  transacted: string[];
}

/** The three identity sources, each its own cheap query — no vendor calls. */
async function loadSymbolContext(userId: string): Promise<SymbolContext> {
  const watchedRows = await db
    .select({ symbol: instruments.symbol })
    .from(watchlist)
    .innerJoin(instruments, eq(watchlist.instrumentId, instruments.id))
    .where(eq(watchlist.userId, userId))
    .orderBy(asc(watchlist.createdAt));

  // The `loadHoldingsInputs`-shaped transactions join, fed to the engine with
  // empty quote/FX maps — held = quantity strictly > 0. Deliberately NOT
  // `loadHoldingsInputs` itself: that walk prices the portfolio (vendor batch,
  // NBP, market status), none of which a symbol list needs.
  const txRows = await db
    .select({
      id: transactions.id,
      instrumentId: transactions.instrumentId,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      currency: instruments.currency,
      side: transactions.side,
      quantity: transactions.quantity,
      price: transactions.price,
      fees: transactions.fees,
      fxRateToBase: transactions.fxRateToBase,
      tradeDate: transactions.tradeDate,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(eq(portfolios.userId, userId));

  const engineTxs: EngineTransaction[] = txRows.map((r) => ({
    ...r,
    side: r.side === 'sell' ? 'sell' : 'buy',
  }));
  const held = computePositions(engineTxs)
    .filter((p) => p.quantity.greaterThan(0))
    .map((p) => p.symbol);

  const underlyingRows = await db
    .selectDistinct({ underlying: optionPositions.underlying })
    .from(optionPositions)
    .where(eq(optionPositions.userId, userId));

  return {
    watched: watchedRows.map((r) => r.symbol),
    held,
    optionUnderlyings: underlyingRows.map((r) => r.underlying),
    transacted: [...new Set(txRows.map((r) => r.symbol))],
  };
}

/**
 * Bounded fan-out: `concurrency` lanes sharing one advancing index over the
 * array — every item runs exactly once, never more than `concurrency`
 * unsettled at any instant, no library. `run` must not reject (the caller's
 * callback catches per item); a rejection here would abandon the lane.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await run(item);
    }
  };
  const lanes = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: lanes }, lane));
}

/**
 * Refresh the store from the vendor if this symbol set's TTL has lapsed —
 * one `ticker=` request per symbol (the only form the vendor's filter
 * honors), {@link NEWS_REFRESH_CONCURRENCY} lanes, collected per symbol so
 * one rejection never discards the others' results. Returns whether the
 * CURRENT window is degraded: failures past
 * {@link NEWS_DEGRADED_FAILURE_RATIO}, or a failed store write. ANY failure
 * — even below the ratio — shortens the window to `NEWS_DEGRADED_TTL_MS` so
 * missing symbols are re-asked soon without raising the flag. Never throws.
 */
async function refreshIfStale(symbols: readonly string[]): Promise<boolean> {
  const key = [...symbols].sort().join(',');
  const now = Date.now();

  const hit = refreshCache.get(key);
  if (hit && now - hit.at < hit.ttlMs) return hit.degraded;

  const attempted = symbols.slice(0, NEWS_MAX_REQUESTS_PER_REFRESH);
  const batches: NewsArticle[][] = [];
  let failed = 0;
  await runWithConcurrency(attempted, NEWS_REFRESH_CONCURRENCY, async (symbol) => {
    try {
      batches.push(await getNewsArticles(symbol, NEWS_PER_SYMBOL_LIMIT));
    } catch {
      failed += 1;
    }
  });
  if (failed > 0) {
    // Never the key, a symbol, or a URL — counts only.
    console.error(`News refresh: ${failed} of ${attempted.length} symbol fetches failed`);
  }

  // Dedupe by article id BEFORE persisting: the same story legitimately
  // arrives from two of the user's symbols, and duplicate ids inside ONE
  // insert statement make Postgres reject the whole statement
  // (`onConflictDoNothing` only forgives conflicts with EXISTING rows).
  const byId = new Map<string, NewsArticle>();
  for (const batch of batches) {
    for (const article of batch) {
      if (!byId.has(article.id)) byId.set(article.id, article);
    }
  }
  const writeOk = await persistArticles([...byId.values()]); // never throws
  await pruneOldArticles();

  // A lost write means the fetched stories never reached the rows the feed
  // reads from — as absent as a failed fetch, so it forces the flag.
  const entry: RefreshCacheEntry = {
    at: now,
    ttlMs: failed > 0 || !writeOk ? NEWS_DEGRADED_TTL_MS : NEWS_TTL_MS,
    degraded: failed / attempted.length > NEWS_DEGRADED_FAILURE_RATIO || !writeOk,
  };

  refreshCache.delete(key);
  if (refreshCache.size >= MAX_REFRESH_CACHE_ENTRIES) {
    const oldest = refreshCache.keys().next().value;
    if (oldest !== undefined) refreshCache.delete(oldest);
  }
  refreshCache.set(key, entry);
  return entry.degraded;
}

/** The ten-newest (or N-newest) stories matching the user's union. */
export async function loadNewsFeed(userId: string, limit: number): Promise<NewsFeed> {
  let omitted: string[] = [];
  try {
    const context = await loadSymbolContext(userId);
    const union = buildNewsSymbolUnion({
      watched: context.watched,
      held: context.held,
      optionUnderlyings: context.optionUnderlyings,
    });
    omitted = union.omitted;

    if (union.symbols.length === 0) {
      return { articles: [], omitted, degraded: false };
    }

    const degraded = await refreshIfStale(union.symbols);

    // The feed reads FROM THE DATABASE — the persisted rows are the identity
    // source, and they survive a vendor outage for free. Distinct articles
    // via the membership subquery; ordering is OURS (`published_at DESC`),
    // never the vendor's.
    const matchingIds = db
      .select({ articleId: newsArticleTickers.articleId })
      .from(newsArticleTickers)
      .where(inArray(newsArticleTickers.ticker, union.symbols));

    const rows = await db
      .select({
        id: newsArticles.id,
        title: newsArticles.title,
        publisherName: newsArticles.publisherName,
        publishedAt: newsArticles.publishedAt,
        imageUrl: newsArticles.imageUrl,
        publisherLogoUrl: newsArticles.publisherLogoUrl,
        publisherFaviconUrl: newsArticles.publisherFaviconUrl,
      })
      .from(newsArticles)
      .where(inArray(newsArticles.id, matchingIds))
      .orderBy(desc(newsArticles.publishedAt))
      .limit(limit);

    // The matched-ticker chips: the returned articles' join rows, intersected
    // with the union (an article legitimately tags symbols the user does not
    // follow — those belong on the detail page, not the chip row).
    const unionSet = new Set(union.symbols);
    const matchedById = new Map<string, string[]>();
    if (rows.length > 0) {
      const joinRows = await db
        .select({ articleId: newsArticleTickers.articleId, ticker: newsArticleTickers.ticker })
        .from(newsArticleTickers)
        .where(
          inArray(
            newsArticleTickers.articleId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(newsArticleTickers.ticker));
      for (const row of joinRows) {
        if (!unionSet.has(row.ticker)) continue;
        const list = matchedById.get(row.articleId);
        if (list) list.push(row.ticker);
        else matchedById.set(row.articleId, [row.ticker]);
      }
    }

    return {
      articles: rows.map((r) => ({
        id: r.id,
        title: r.title,
        publisherName: r.publisherName,
        // A timestamp, not money — epoch ms out of timestamptz.
        publishedAtMs: r.publishedAt.getTime(),
        hasImage: r.imageUrl !== null,
        hasPublisherLogo:
          isServablePublisherAssetUrl(r.publisherLogoUrl) ||
          isServablePublisherAssetUrl(r.publisherFaviconUrl),
        matchedTickers: matchedById.get(r.id) ?? [],
      })),
      omitted,
      degraded,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'news feed failed';
    console.error(`News feed load failed: ${message}`);
    return { articles: [], omitted, degraded: true };
  }
}

export interface TickerNews {
  articles: NewsFeedItem[];
  /** The freshest refresh attempt failed; rows may be stale. */
  degraded: boolean;
}

/**
 * News for ONE of the user's own symbols — the instrument page, the option
 * contract page (its underlying) and the `/news?ticker=` filtered list all
 * read through here.
 *
 * AUTHORIZATION FIRST, and it FAILS CLOSED: the candidate symbol is
 * re-validated against the user's own sources (watched ∪ held ∪ option
 * underlyings ∪ ever-transacted, per `KnownSymbolSources`) via
 * `resolveKnownSymbol`; anything outside that set returns `null` — so no
 * call site, present or future, can turn this into an arbitrary-symbol
 * vendor query or an existence oracle. A failure BEFORE resolution completes
 * also returns `null`: the loader must never answer — not even a
 * degraded-empty frame — for a symbol it could not check, so a non-null
 * return always means "this symbol is yours". Only a failure AFTER
 * validation is the distinct `{ articles: [], degraded: true }`, same as
 * `loadNewsFeed`.
 *
 * Fetch-if-thin: stored rows first; only when fewer than
 * {@link TICKER_NEWS_THIN_THRESHOLD} exist does the vendor get asked — via
 * the same `refreshIfStale` TTL cache (per-symbol key), persisting through
 * `store.ts`. A vendor failure degrades to the stored rows; nothing here
 * throws to a page.
 */
export async function loadTickerNews(
  userId: string,
  symbol: string,
  limit: number,
): Promise<TickerNews | null> {
  let context: SymbolContext;
  let resolved: string | null;
  try {
    context = await loadSymbolContext(userId);
    resolved = resolveKnownSymbol(symbol, {
      watched: context.watched,
      held: context.held,
      optionUnderlyings: context.optionUnderlyings,
      // Ever-transacted qualifies here — /holdings/[ticker] renders for any
      // symbol with transaction history and the transaction actions redirect
      // there after an edit or delete, so a closed-out position's page is a
      // legitimate news surface. The union feed below deliberately stays
      // narrow (see SymbolContext.transacted).
      transacted: context.transacted,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ticker news failed';
    console.error(`Ticker news validation failed: ${message}`);
    // Fail CLOSED: resolution never completed, so this candidate was never
    // authorized — `null`, exactly as if it were not the user's symbol. The
    // degraded-empty shape is reserved for failures AFTER validation.
    return null;
  }
  if (resolved === null) return null;
  // A const rebinding so the closures below capture a plain `string` — the
  // narrowing on the mutable `resolved` would not survive into them.
  const known = resolved;

  try {
    const readRows = () =>
      db
        .select({
          id: newsArticles.id,
          title: newsArticles.title,
          publisherName: newsArticles.publisherName,
          publishedAt: newsArticles.publishedAt,
          imageUrl: newsArticles.imageUrl,
          publisherLogoUrl: newsArticles.publisherLogoUrl,
          publisherFaviconUrl: newsArticles.publisherFaviconUrl,
        })
        .from(newsArticles)
        .where(
          inArray(
            newsArticles.id,
            db
              .select({ articleId: newsArticleTickers.articleId })
              .from(newsArticleTickers)
              .where(eq(newsArticleTickers.ticker, known)),
          ),
        )
        .orderBy(desc(newsArticles.publishedAt))
        .limit(limit);

    let rows = await readRows();
    let degraded = false;
    if (rows.length < TICKER_NEWS_THIN_THRESHOLD) {
      degraded = await refreshIfStale([known]);
      rows = await readRows();
    }

    // The matched-ticker chips, as `loadNewsFeed` computes them — article
    // tickers ∩ the user's union — so a story tagged with several of the
    // user's tickers shows the same chips on every surface.
    const union = buildNewsSymbolUnion({
      watched: context.watched,
      held: context.held,
      optionUnderlyings: context.optionUnderlyings,
    });
    const unionSet = new Set(union.symbols);
    // Plus the resolved symbol itself: on its OWN surface it is always a
    // legitimate chip. For a held/watched symbol this is a no-op (already in
    // the union); for a closed-out, transacted-only one the union deliberately
    // excludes it, and without this its section's cards could never name it —
    // which would break the "every card names ≥ 1 chip" invariant.
    unionSet.add(known);
    const matchedById = new Map<string, string[]>();
    if (rows.length > 0) {
      const joinRows = await db
        .select({ articleId: newsArticleTickers.articleId, ticker: newsArticleTickers.ticker })
        .from(newsArticleTickers)
        .where(
          inArray(
            newsArticleTickers.articleId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(newsArticleTickers.ticker));
      for (const row of joinRows) {
        if (!unionSet.has(row.ticker)) continue;
        const list = matchedById.get(row.articleId);
        if (list) list.push(row.ticker);
        else matchedById.set(row.articleId, [row.ticker]);
      }
    }

    return {
      articles: rows.map((r) => ({
        id: r.id,
        title: r.title,
        publisherName: r.publisherName,
        // A timestamp, not money — epoch ms out of timestamptz.
        publishedAtMs: r.publishedAt.getTime(),
        hasImage: r.imageUrl !== null,
        hasPublisherLogo:
          isServablePublisherAssetUrl(r.publisherLogoUrl) ||
          isServablePublisherAssetUrl(r.publisherFaviconUrl),
        matchedTickers: matchedById.get(r.id) ?? [],
      })),
      degraded,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ticker news failed';
    console.error(`Ticker news load failed: ${message}`);
    // A failure HERE happened after validation, so degraded-empty is honest —
    // DISTINCT from `null`, which is reserved for "not your symbol, or never
    // validated". Both answers are empty of articles, so neither can leak;
    // and the degraded shape lets an already-authorized page say
    // "unavailable" instead of silently hiding the section.
    return { articles: [], degraded: true };
  }
}

/**
 * One stored article for the detail page — DATABASE ONLY, never the vendor
 * (a by-id vendor lookup silently returns the WRONG article). Null when the
 * id is unknown or the row has been pruned; the page renders `notFound()`.
 * Throws only on a database failure — the page boundary treats that as
 * `notFound()` too rather than a 500 with a stack.
 */
export async function loadNewsArticleDetail(
  userId: string,
  id: string,
): Promise<NewsArticleDetail | null> {
  const [row] = await db.select().from(newsArticles).where(eq(newsArticles.id, id)).limit(1);
  if (row === undefined) return null;

  const tickerRows = await db
    .select({ ticker: newsArticleTickers.ticker })
    .from(newsArticleTickers)
    .where(eq(newsArticleTickers.articleId, id))
    .orderBy(asc(newsArticleTickers.ticker));

  // Tappable = watched or held ONLY — `/holdings/[ticker]` 404s for
  // anything else by design, and a link that lands on a 404 is worse than
  // plain text. Option underlyings deliberately do not qualify.
  const context = await loadSymbolContext(userId);
  const linkable = new Set([...context.watched, ...context.held].map((s) => s.toUpperCase()));

  const tickers = tickerRows.map((r) => r.ticker);
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    publisherName: row.publisherName,
    publisherHomepage: row.publisherHomepage,
    publishedAtMs: row.publishedAt.getTime(),
    articleUrl: row.articleUrl,
    hasImage: row.imageUrl !== null,
    description: row.description,
    keywords: row.keywords,
    insights: row.insights,
    tickers,
    linkableTickers: tickers.filter((t) => linkable.has(t)),
  };
}
