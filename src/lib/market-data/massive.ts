import 'server-only';

import { env } from '@/lib/env';
import { getPriorClosesBySymbol } from '@/lib/history/prior-closes';
import { dec } from '@/lib/money';

import { mergeCalendarSources } from './calendar-merge';
import { persistFetchedCalendar, readStoredCalendar } from './calendar-store';
import {
  lastCompletedSessionDateISO,
  nextSessionActivity,
  nextTransition,
  nyDateISOAt,
  statusAt,
  type CalendarOverride,
} from './market-clock';
import {
  aggsPath,
  aggsResponseSchema,
  dividendsParams,
  dividendsResponseSchema,
  mapAggsResults,
  mapDividendResults,
  mapBrandingIconUrl,
  mapMarketStatusNow,
  mapOptionContracts,
  mapOptionSnapshotResult,
  mapSnapshotResult,
  mapTickerResults,
  mapUnderlyingSpot,
  mapUpcomingToOverrides,
  marketStatusNowSchema,
  marketUpcomingSchema,
  mapNewsResults,
  mixedSnapshotResponseSchema,
  newsParams,
  newsResponseSchema,
  nextExpirationQueryDate,
  optionContractsParams,
  optionContractsResponseSchema,
  reconcileTransition,
  rolledPrevClose,
  snapshotParams,
  snapshotResponseSchema,
  substituteDayPair,
  mapTickerProfile,
  tickerOverviewSchema,
  tickerProfileSchema,
  tickersResponseSchema,
  type MixedSnapshotResult,
  type NewsArticle,
  type SnapshotResult,
} from './massive-mapping';
import { streamPrices } from './massive-stream';
import type {
  OptionContractRef,
  OptionExpiry,
  OptionQuoteOutcome,
} from './options-types';
import { rankDirectoryMatches } from './nasdaq-directory';
import type {
  BarSpec,
  BrandingIconOutcome,
  Candle,
  DividendEvent,
  MarketSessionInfo,
  Quote,
  QuoteOutcome,
  QuoteProvider,
  SymbolSearchResult,
  TickerProfileOutcome,
} from './provider';
import type { SymbolMatch } from './symbol-search';

/**
 * The Massive REST adapter — with `massive-stream.ts` (the delayed
 * WebSocket), one of exactly two files that know a vendor URL or read
 * `STOCK_API`. `server-only`: a client component importing this is a build
 * error, which is the guard that keeps the key out of the browser bundle.
 * Mapping is pure and lives in `massive-mapping.ts`.
 *
 * Starter tier: unlimited REST calls, 15-minute-delayed data. No rate
 * limiter by design — but batching stays (it is simply correct), chunks are
 * fetched sequentially, and per-symbol endpoints must never be fanned out
 * with an unbounded `Promise.all`.
 */

const BASE_URL = 'https://api.massive.com';

const FETCH_TIMEOUT_MS = 5000;

/**
 * Search-path timeout, deliberately shorter: on a network-level outage every
 * unique query pays the full timeout as a visible "Searching…" stall before
 * the local directory (which answers instantly) even gets asked. 2 s keeps
 * that stall tolerable; quote/bar paths keep the full 5 s.
 */
const SEARCH_TIMEOUT_MS = 2000;

/** Snapshot `ticker.any_of` accepts at most 250 tickers per request. */
const MAX_BATCH = 250;

/** Defensive bound on `next_url` pagination — one full batch never needs it. */
const MAX_PAGES = 5;

/** Starter tier data runs 15 minutes behind the live market. */
const DELAY_SECONDS = 900;

const NAME = 'massive';

/** Fetch 25 search candidates — well above the 8 the route serves, so the
 *  US/type filter has room to drop noise without starving the list. */
const SEARCH_LIMIT = 25;

const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEARCH_CACHE_ENTRIES = 500;

/**
 * Authenticated GET against Massive. The path is always a code-owned constant
 * and every parameter goes through `URLSearchParams` — user input is never
 * string-interpolated into a URL. Throws on non-2xx/timeout/network/non-JSON;
 * callers decide whether that degrades or propagates.
 */
async function massiveFetch(
  path: string,
  params?: URLSearchParams,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const url = params ? `${BASE_URL}${path}?${params}` : `${BASE_URL}${path}`;
  return fetchJson(url, timeoutMs);
}

/** Non-2xx from the vendor, with the status machine-readable — the message
 *  stays status-only (never the body, which could echo the request URL). */
class MassiveHttpError extends Error {
  constructor(readonly status: number) {
    super(`Massive request failed: HTTP ${status}`);
    this.name = 'MassiveHttpError';
  }
}

async function fetchJson(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env().STOCK_API}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new MassiveHttpError(response.status);
  }
  return response.json();
}

interface SearchCacheEntry {
  at: number;
  results: SymbolMatch[];
}

/**
 * In-process, per-instance search cache — best-effort on serverless
 * (evaporates on cold start), fine at exactly one user. Insertion order
 * doubles as eviction order (oldest first). ONLY successes are cached: a
 * cached failure would masquerade as "no such symbol" for 24 hours.
 */
const searchCache = new Map<string, SearchCacheEntry>();

async function getQuotes(symbols: readonly string[]): Promise<Map<string, QuoteOutcome>> {
  const outcomes = new Map<string, QuoteOutcome>();
  if (symbols.length === 0) return outcomes;

  // Reconciliation index: Massive returns uppercase tickers; keep the caller's
  // exact strings as the map keys.
  const requestedByUpper = new Map<string, string>();
  for (const symbol of symbols) requestedByUpper.set(symbol.toUpperCase(), symbol);

  const now = new Date();

  // The merged holiday/early-close calendar plus the store's coverage
  // horizon feed the closed-branch extended-hours attribution in the mapper.
  // Never throws, 6 h-cached — no extra vendor or DB call on the hot poll
  // path in practice.
  const { overrides, knownFromISO } = await getCalendarState();

  // Sequential chunks, deliberately — one user, no fan-out.
  for (let i = 0; i < symbols.length; i += MAX_BATCH) {
    const chunk = symbols.slice(i, i + MAX_BATCH);

    let results: SnapshotResult[];
    try {
      results = await fetchSnapshotPages(chunk);
    } catch (error) {
      // The whole chunk failed (network/timeout/HTTP/parse): every symbol in
      // it gets an explicit error outcome — never a thrown batch. Log the
      // reason so a dead key is visible in server logs, not just in outcomes.
      // Never the key, the header, or a URL — message/status only.
      const message = error instanceof Error ? error.message : 'snapshot fetch failed';
      console.error(`Massive snapshot chunk failed (${chunk.length} symbols): ${message}`);
      for (const symbol of chunk) {
        outcomes.set(symbol, { ok: false, symbol, reason: 'error', message });
      }
      continue;
    }

    for (const raw of results) {
      const outcome = mapSnapshotResult(raw, {
        delaySeconds: DELAY_SECONDS,
        source: NAME,
        now,
        overrides,
        calendarKnownFromISO: knownFromISO,
      });
      if (!outcome) continue; // no ticker — unusable for reconciliation
      const key = outcome.ok ? outcome.quote.symbol : outcome.symbol;
      const requested = requestedByUpper.get(key.toUpperCase());
      if (requested !== undefined) outcomes.set(requested, outcome);
    }
  }

  // Every requested symbol Massive did not return degrades to an explicit
  // not_found — this is how stored non-US rows (e.g. `CDR.WA`) stay harmless.
  for (const symbol of symbols) {
    if (!outcomes.has(symbol)) {
      outcomes.set(symbol, { ok: false, symbol, reason: 'not_found' });
    }
  }

  // Pre-open ROLLED-state day-pair substitution (defect fix, 2026-08-14):
  // overnight the vendor rolls `previous_close` to equal the session close,
  // so every non-open day pair degenerates to 0.00% until the bell. Quotes
  // matching that signature get their pair re-derived from the cached prior
  // close of the last COMPLETED session — Yahoo's pre-open behavior. The
  // displayed price and `prevClose` are untouched (see `substituteDayPair`);
  // wiring it here, after reconciliation, covers every consumer at once:
  // `/api/quotes`, both SSE streams' REST baselines, the Watchlist twins and
  // the instrument-page header. Any history failure degrades to the
  // unsubstituted outcomes — quotes never break on history.
  const rolled: [string, Quote][] = [];
  for (const [requested, outcome] of outcomes) {
    if (outcome.ok && rolledPrevClose(outcome.quote)) rolled.push([requested, outcome.quote]);
  }
  if (rolled.length > 0) {
    // Data-driven baseline date: the close of the session BEFORE the last
    // completed one is whatever `price_snapshots` holds strictly before that
    // last completed date. Null only on a degenerate calendar scan — the
    // vendor pair is then left as-is.
    const lastCompleted = lastCompletedSessionDateISO(now.getTime(), overrides);
    if (lastCompleted !== null) {
      try {
        const priors = await getPriorClosesBySymbol(
          rolled.map(([requested]) => requested),
          lastCompleted,
        );
        for (const [requested, quote] of rolled) {
          outcomes.set(requested, {
            ok: true,
            quote: substituteDayPair(quote, priors.get(requested) ?? null),
          });
        }
      } catch (error) {
        // Never the key, the header, or a URL — message/status only.
        const message = error instanceof Error ? error.message : 'prior-close read failed';
        console.error(`Rolled day-pair substitution failed (${rolled.length} symbols): ${message}`);
      }
    }
  }

  return outcomes;
}

/**
 * Bounded, same-origin `next_url` page walk — generalized (2026-08-14,
 * options-tracking plan) from the original snapshot-only walker so option
 * snapshots and the contracts reference share ONE fetch path instead of
 * growing a second one. Schema-parameterized via `parse` (null = parse
 * failure); the stock call site below keeps byte-identical behavior: same
 * `MAX_PAGES` bound, same origin check, same error message shape.
 *
 * `maxItems` (2026-08-16, news): stop following `next_url` once enough
 * results are already collected. The news feed is effectively infinite — a
 * cursor is ALWAYS present (verified live 2026-08-16) — so without this the
 * walk would burn all `MAX_PAGES` fetches on every refresh to collect items
 * the caller then discards. Defaults to unbounded; every prior call site is
 * byte-identical in behavior.
 */
async function fetchPagedResults<T>(
  label: string,
  path: string,
  params: URLSearchParams,
  parse: (body: unknown) => { results?: T[]; next_url?: string } | null,
  maxItems: number = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  const collected: T[] = [];
  let body = await massiveFetch(path, params);

  for (let page = 0; ; page++) {
    const parsed = parse(body);
    if (parsed === null) throw new Error(`Massive ${label}: unrecognized response body`);

    collected.push(...(parsed.results ?? []));

    if (collected.length >= maxItems) break;
    const nextUrl = parsed.next_url;
    if (!nextUrl) break;
    // Same-origin only — never follow a cursor off the vendor host.
    if (!nextUrl.startsWith(`${BASE_URL}/`)) break;
    // Page bound checked BEFORE the fetch — never request a body that would
    // go unparsed.
    if (page + 1 >= MAX_PAGES) break;
    body = await fetchJson(nextUrl);
  }

  return collected;
}

/** One snapshot batch, following `next_url` defensively (bounded, same-origin). */
async function fetchSnapshotPages(chunk: readonly string[]): Promise<SnapshotResult[]> {
  // `limit` is set to the chunk size explicitly — the API default is 10, and
  // a 40-ticker request without it silently returns 10 results.
  return fetchPagedResults('snapshot', '/v3/snapshot', snapshotParams(chunk), (body) => {
    const parsed = snapshotResponseSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  });
}

/**
 * The ONE aggregate-bars fetch path — daily history and 5/30-minute intraday
 * alike. One upstream call per symbol by API design — callers must not
 * `Promise.all` large symbol sets over this; iterate sequentially instead.
 * Error discipline unchanged: throws, and the caller decides how to degrade.
 */
async function fetchAggregates(symbol: string, spec: BarSpec): Promise<Candle[]> {
  const params = new URLSearchParams({ adjusted: 'true', sort: 'asc', limit: '50000' });

  const body = await massiveFetch(aggsPath(symbol, spec), params);
  const parsed = aggsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error('Massive aggs: unrecognized response body');

  return mapAggsResults(parsed.data.results ?? []);
}

/**
 * Intraday bars are NOT cached in the database (delayed data, still being
 * appended to during a session — a stored copy would be permanently stale).
 * This in-process 60 s cache is the whole intraday caching story: it absorbs
 * a burst of chart range-switches, evaporates on cold start, and only ever
 * holds successes (a cached failure would blank the chart for a minute).
 */
const INTRADAY_TTL_MS = 60_000;
const MAX_INTRADAY_CACHE_ENTRIES = 200;

interface IntradayCacheEntry {
  at: number;
  candles: Candle[];
}

/** Keyed by the full request path — insertion order doubles as eviction order. */
const intradayCache = new Map<string, IntradayCacheEntry>();

/** Aggregate bars at any granularity; intraday goes through the TTL cache. */
async function getAggregates(symbol: string, spec: BarSpec): Promise<Candle[]> {
  if (spec.timespan === 'day') return fetchAggregates(symbol, spec);

  const key = aggsPath(symbol, spec);
  const now = Date.now();
  const hit = intradayCache.get(key);
  if (hit) {
    if (now - hit.at < INTRADAY_TTL_MS) return hit.candles;
    intradayCache.delete(key);
  }

  const candles = await fetchAggregates(symbol, spec);
  if (intradayCache.size >= MAX_INTRADAY_CACHE_ENTRIES) {
    const oldest = intradayCache.keys().next().value;
    if (oldest !== undefined) intradayCache.delete(oldest);
  }
  intradayCache.set(key, { at: now, candles });
  return candles;
}

/** Daily bars — a thin alias over the shared fetch path (one path, not two). */
async function getDailyCloses(symbol: string, from: string, to: string): Promise<Candle[]> {
  return fetchAggregates(symbol, { multiplier: 1, timespan: 'day', from, to });
}

/**
 * Symbol search, Massive-primary. Failure discipline carried over verbatim
 * from the previous provider adapter: bounded timeout, and every failure mode
 * (non-2xx, timeout, network error, parse failure) lands on the degraded path
 * and is NOT cached — a 24 h cached empty result would read as "symbol
 * doesn't exist" all day.
 */
async function searchSymbols(query: string): Promise<SymbolSearchResult> {
  const key = query.trim().toLowerCase();
  const now = Date.now();

  const hit = searchCache.get(key);
  if (hit) {
    if (now - hit.at < SEARCH_TTL_MS) return { results: hit.results, degraded: false };
    searchCache.delete(key);
  }

  let body: unknown;
  try {
    const params = new URLSearchParams({
      search: query.trim(),
      market: 'stocks',
      active: 'true',
      limit: String(SEARCH_LIMIT),
    });
    body = await massiveFetch('/v3/reference/tickers', params, SEARCH_TIMEOUT_MS);
  } catch (error) {
    // The degraded UX stays quiet by design; the server log must not — a bad
    // or expired key would otherwise be invisible for weeks. Never log the
    // key, the header, or a URL: message/status only.
    const message = error instanceof Error ? error.message : 'search fetch failed';
    console.error(`Massive search failed: ${message}`);
    return { results: [], degraded: true };
  }

  const parsed = tickersResponseSchema.safeParse(body);
  if (!parsed.success) {
    console.error('Massive search failed: unrecognized response body');
    return { results: [], degraded: true };
  }

  // One ranking algorithm for primary and fallback: Massive rows become
  // DirectoryRows, then rankDirectoryMatches produces the SymbolMatch[]
  // (which stamps currency: 'USD' — guaranteed by the US-only filters).
  const results = rankDirectoryMatches(query, mapTickerResults(parsed.data.results ?? []));

  if (searchCache.size >= MAX_SEARCH_CACHE_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { at: now, results });

  return { results, degraded: false };
}

/* ------------------------------------------------------------------ *
 * Company branding — the logo asset route's backend, and ONLY its
 * backend: never called from getHoldingsView or anything on the 10 s
 * poll path. Two fetches: resolve `icon_url` via the reference
 * endpoint, then stream the bytes — both authenticated here and only
 * here, so the key never reaches a client or a log line.
 * ------------------------------------------------------------------ */

/** Positive answers barely churn — a rebrand tolerates a month of lag. */
const BRANDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Negative answers retry daily: a `.WA` symbol must not hammer the
 *  reference endpoint, but a newly-branded ticker should surface within a day. */
const BRANDING_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BRANDING_CACHE_ENTRIES = 500;

/** Defensive cap on icon bytes — observed tiles are ~6 KB; 1 MB is already
 *  absurd, and an unbounded body would ride into the route's response. */
const MAX_ICON_BYTES = 1024 * 1024;

/**
 * The only Content-Types this route will re-serve from our own origin.
 * `image/svg+xml` is deliberately EXCLUDED: an SVG is a script-carrying
 * document, and serving one from our origin would hand a compromised vendor a
 * same-origin XSS sink. The icon endpoint serves raster tiles (observed:
 * image/jpeg); a raster-only allowlist costs us nothing.
 */
const ICON_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface BrandingCacheEntry {
  at: number;
  /** null is a definitive "no icon" (e.g. `branding: null` on `.WA` rows). */
  iconUrl: string | null;
}

/**
 * symbol → resolved icon URL, per-instance like `searchCache`. Only
 * DEFINITIVE answers (a parsed vendor response) are cached — a transient
 * failure cached as null would render a month of monograms.
 */
const brandingCache = new Map<string, BrandingCacheEntry>();

/** Resolved icon URL for a symbol, through the cache; undefined = transient failure. */
async function resolveIconUrl(symbol: string): Promise<string | null | undefined> {
  const key = symbol.toUpperCase();
  const now = Date.now();

  const hit = brandingCache.get(key);
  if (hit) {
    const ttl = hit.iconUrl === null ? BRANDING_NEGATIVE_TTL_MS : BRANDING_TTL_MS;
    if (now - hit.at < ttl) return hit.iconUrl;
    brandingCache.delete(key);
  }

  let body: unknown;
  try {
    body = await massiveFetch(`/v3/reference/tickers/${encodeURIComponent(symbol)}`);
  } catch (error) {
    if (error instanceof MassiveHttpError && error.status === 404) {
      // Definitive: the vendor does not know the ticker at all.
      return null;
    }
    // Never the key, the header, or a URL — message/status only.
    const message = error instanceof Error ? error.message : 'branding fetch failed';
    console.error(`Massive branding lookup failed: ${message}`);
    return undefined;
  }

  const parsed = tickerOverviewSchema.safeParse(body);
  if (!parsed.success) {
    console.error('Massive branding lookup failed: unrecognized response body');
    return undefined;
  }

  const iconUrl = mapBrandingIconUrl(parsed.data);
  if (brandingCache.size >= MAX_BRANDING_CACHE_ENTRIES) {
    const oldest = brandingCache.keys().next().value;
    if (oldest !== undefined) brandingCache.delete(oldest);
  }
  brandingCache.set(key, { at: now, iconUrl });
  return iconUrl;
}

/* ------------------------------------------------------------------ *
 * Ticker profile (sector / SIC) — the analytics backfill.
 * ------------------------------------------------------------------ */

/** A company's industry does not change on a weekly cadence. */
const PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A vendor that has no profile for a ticker is unlikely to grow one today. */
const PROFILE_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROFILE_CACHE_ENTRIES = 500;

interface ProfileCacheEntry {
  at: number;
  outcome: TickerProfileOutcome;
}

/**
 * symbol → outcome, per-instance, mirroring `brandingCache` rule for rule:
 * only DEFINITIVE answers are cached. A transient failure cached as an answer
 * would freeze a whole month of "Unknown" onto a company the vendor knows
 * perfectly well — and `{ ok: false, reason: 'error' }` never enters this map
 * at all.
 */
const profileCache = new Map<string, ProfileCacheEntry>();

/**
 * Sector / SIC for one symbol, over the SAME
 * `/v3/reference/tickers/{ticker}` fetch the branding path uses — one
 * endpoint, two readers, one vendor call per symbol.
 *
 * Never throws by contract, and the outcome says which kind of nothing it
 * got: a 404 is a definitive `not_found` (cached), an answer the vendor gave
 * is `ok` even when every field on it is null (cached), and every transient
 * failure is an UNCACHED `error` plus a log line carrying the message or
 * status ONLY — never the key, never a URL, never the symbol's owner. The
 * distinction is load-bearing: the caller writes and stamps on a definitive
 * outcome and touches nothing on a transient one.
 */
async function getTickerProfile(symbol: string): Promise<TickerProfileOutcome> {
  const key = symbol.toUpperCase();
  const now = Date.now();

  const hit = profileCache.get(key);
  if (hit) {
    const ttl = hit.outcome.ok ? PROFILE_TTL_MS : PROFILE_NEGATIVE_TTL_MS;
    if (now - hit.at < ttl) return hit.outcome;
    profileCache.delete(key);
  }

  let body: unknown;
  try {
    body = await massiveFetch(`/v3/reference/tickers/${encodeURIComponent(symbol)}`);
  } catch (error) {
    if (error instanceof MassiveHttpError && error.status === 404) {
      // Definitive: the vendor does not know this ticker at all.
      return rememberProfile(key, { ok: false, reason: 'not_found' }, now);
    }
    const message = error instanceof Error ? error.message : 'profile fetch failed';
    console.error(`Massive ticker profile lookup failed: ${message}`);
    return { ok: false, reason: 'error' };
  }

  const parsed = tickerProfileSchema.safeParse(body);
  if (!parsed.success) {
    // A body this adapter cannot read is a FAILURE, not an answer of
    // "nothing": writing nulls from it would erase a classification the
    // vendor still holds (e.g. a `sic_code` that arrived as a number).
    console.error('Massive ticker profile lookup failed: unrecognized response body');
    return { ok: false, reason: 'error' };
  }

  return rememberProfile(key, { ok: true, profile: mapTickerProfile(parsed.data) }, now);
}

function rememberProfile(
  key: string,
  outcome: TickerProfileOutcome,
  at: number,
): TickerProfileOutcome {
  if (profileCache.size >= MAX_PROFILE_CACHE_ENTRIES) {
    const oldest = profileCache.keys().next().value;
    if (oldest !== undefined) profileCache.delete(oldest);
  }
  profileCache.set(key, { at, outcome });
  return outcome;
}

/**
 * Brand icon bytes for a symbol. Verified live 2026-08-10: `icon_url` points
 * back at the vendor origin (`api.massive.com/v1/reference/company-branding/…`)
 * and the asset endpoint accepts the same `Authorization: Bearer` header
 * (unauthenticated requests get 401) — so no `?apiKey=` query fallback exists
 * here, and the origin check below means the key is only ever attached to a
 * vendor-origin URL. A different origin degrades to `not_found` (monogram),
 * never a key sent to a third host.
 */
async function getBrandingIcon(symbol: string): Promise<BrandingIconOutcome> {
  const iconUrl = await resolveIconUrl(symbol);
  if (iconUrl === undefined) return { ok: false, reason: 'error' };
  if (iconUrl === null || !iconUrl.startsWith(`${BASE_URL}/`)) {
    return { ok: false, reason: 'not_found' };
  }

  try {
    const response = await fetch(iconUrl, {
      headers: { Authorization: `Bearer ${env().STOCK_API}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
      // The origin check above guards the URL we ASK for; without this it would
      // not guard the URL we END UP at. `follow` would let a vendor-side 302
      // walk this authenticated fetch to an arbitrary host after the gate
      // passed, and proxy the bytes back through our route. (Node strips the
      // Authorization header cross-origin, so the key itself is never at risk —
      // verified 2026-08-10 — but the SSRF-shaped hole is closed here.)
      redirect: 'error',
    });
    if (response.status === 404) return { ok: false, reason: 'not_found' };
    if (!response.ok) {
      console.error(`Massive branding icon failed: HTTP ${response.status}`);
      return { ok: false, reason: 'error' };
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_ICON_BYTES) {
      console.error(`Massive branding icon failed: body too large (${bytes.byteLength} bytes)`);
      return { ok: false, reason: 'error' };
    }
    // Content-Type is vendor-controlled and gets re-served from OUR origin, so
    // it is pinned to an image allowlist rather than passed through: a
    // `text/html` pass-through would make the route a same-origin HTML sink.
    const vendorType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const contentType = ICON_CONTENT_TYPES.has(vendorType) ? vendorType : 'image/jpeg';

    return { ok: true, bytes, contentType };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'icon fetch failed';
    console.error(`Massive branding icon failed: ${message}`);
    return { ok: false, reason: 'error' };
  }
}

/* ------------------------------------------------------------------ *
 * Publisher logos (2026-08-16, massive-tier0 plan) — the news
 * publisher-logo route's backend, and ONLY its backend. VERIFIED LIVE
 * 2026-08-16 (probe over the real feed), and the finding REVERSES the
 * plan's authenticated-pattern assumption: publisher assets are hosted
 * on the vendor's PUBLIC asset bucket (`https://s3.massive.com/public/
 * assets/news/…`), not the API origin — a bare fetch answers 200, and
 * a request carrying `Authorization: Bearer` is REJECTED with 400 (the
 * bucket treats the header as a malformed AWS signature). So: the API
 * origin keeps the credentialed branding discipline (in case assets
 * ever move behind it), the asset bucket is fetched with NO headers at
 * all (the news-image uncredentialed rationale — a fetch that carries
 * nothing can leak nothing), and ANY other origin is a definitive
 * not_found — the key never travels toward a third host, and neither
 * does a request on the user's behalf. Shared discipline either way:
 * `redirect: 'error'`, 5 s timeout, 1 MB cap on buffered bytes, and a
 * raster + ICO content-type allowlist (`image/svg+xml` deliberately
 * EXCLUDED — an SVG re-served from our origin is a same-origin XSS
 * sink; observed live: `logo_url` IS often svg, and the ICO favicon
 * rasterizes the gap). Second live finding: the bucket serves `.ico`
 * as `application/octet-stream`, so an `.ico` PATH with that vendor
 * type is re-served pinned to `image/x-icon` — our own type, never a
 * pass-through of the vendor's claim.
 * ------------------------------------------------------------------ */

/** The vendor's public asset bucket — verified live 2026-08-16; the ONLY
 *  origin besides {@link BASE_URL} this module will fetch, and always
 *  uncredentialed (the bucket 400s an Authorization header). */
const ASSET_BASE_URL = 'https://s3.massive.com';

/**
 * Raster + ICO — the publisher-logo allowlist. Distinct from
 * `ICON_CONTENT_TYPES` because favicons are legitimately ICO; SVG stays out
 * (see the section comment above).
 */
const PUBLISHER_LOGO_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

/**
 * Static servability pre-check for a STORED publisher asset URL — the news
 * feed's `hasPublisherLogo` gate (2026-08-16 gap fix). Mirrors the two
 * fetch-time refusals that are knowable WITHOUT a request: the two-origin
 * allowlist (any other origin is a definitive not_found in
 * {@link getPublisherLogoAsset}), and the SVG exclusion (observed live:
 * `logo_url` IS often svg, which the proxy refuses by content-type — so
 * promising a logo for an svg-only publisher would render a permanent
 * negative-cached 404 box beside the publisher name). Content-type is only
 * knowable at fetch time, so the route stays authoritative; this predicate
 * only keeps the feed from PROMISING an image the route is certain to
 * refuse. Pure — no fetch, no env read.
 */
export function isServablePublisherAssetUrl(url: string | null): boolean {
  if (url === null) return false;
  if (!url.startsWith(`${BASE_URL}/`) && !url.startsWith(`${ASSET_BASE_URL}/`)) return false;
  try {
    // The PATH decides — a query string cannot hide or fake the suffix.
    return !new URL(url).pathname.toLowerCase().endsWith('.svg');
  } catch {
    return false;
  }
}

/** Publisher logos churn ~never; failures retry daily (the branding TTLs). */
const PUBLISHER_LOGO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLISHER_LOGO_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PUBLISHER_LOGO_CACHE_ENTRIES = 100;

interface PublisherLogoCacheEntry {
  at: number;
  outcome: BrandingIconOutcome;
}

/**
 * URL-keyed outcome cache — the `brandingCache` pattern, DEFINITIVE answers
 * only (success bytes, or a definitive not_found: wrong origin, 404,
 * non-allowlisted type). Transient errors are never cached. The point:
 * every Benzinga story shares one logo URL, and without this each article's
 * card would re-fetch the same ~KB tile through the vendor.
 */
const publisherLogoCache = new Map<string, PublisherLogoCacheEntry>();

/**
 * Publisher logo/favicon bytes for a DB-stored URL. Never throws — every
 * failure mode lands in `{ ok: false }`. NOT on `QuoteProvider` (the
 * options/news precedent: a server-mediated sibling export) and NOT for any
 * poll path: only the publisher-logo asset route may call this.
 */
export async function getPublisherLogoAsset(url: string): Promise<BrandingIconOutcome> {
  // Exactly two fetchable origins (see the section comment): the API origin
  // takes the Bearer key, the public asset bucket takes NO headers at all
  // (verified live: it rejects the key with 400), and anything else is a
  // definitive not_found — never a credential, or any request, toward a
  // third host.
  const credentialed = url.startsWith(`${BASE_URL}/`);
  if (!credentialed && !url.startsWith(`${ASSET_BASE_URL}/`)) {
    return { ok: false, reason: 'not_found' };
  }

  const now = Date.now();
  const hit = publisherLogoCache.get(url);
  if (hit) {
    const ttl = hit.outcome.ok ? PUBLISHER_LOGO_TTL_MS : PUBLISHER_LOGO_NEGATIVE_TTL_MS;
    if (now - hit.at < ttl) return hit.outcome;
    publisherLogoCache.delete(url);
  }

  const store = (outcome: BrandingIconOutcome): BrandingIconOutcome => {
    if (publisherLogoCache.size >= MAX_PUBLISHER_LOGO_CACHE_ENTRIES) {
      const oldest = publisherLogoCache.keys().next().value;
      if (oldest !== undefined) publisherLogoCache.delete(oldest);
    }
    publisherLogoCache.set(url, { at: now, outcome });
    return outcome;
  };

  try {
    const response = await fetch(url, {
      // The key rides ONLY toward the API origin; the asset bucket gets a
      // header-less request (it 400s the Bearer header — verified live).
      ...(credentialed ? { headers: { Authorization: `Bearer ${env().STOCK_API}` } } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
      // The origin check above guards the URL we ASK for; `redirect: 'error'`
      // guards the URL we END UP at — the getBrandingIcon SSRF rationale,
      // verbatim: `follow` would let a vendor-side 302 walk this fetch to an
      // arbitrary host after the gate passed.
      redirect: 'error',
    });
    if (response.status === 404) return store({ ok: false, reason: 'not_found' });
    if (!response.ok) {
      console.error(`Massive publisher logo failed: HTTP ${response.status}`);
      // Transient — deliberately NOT cached.
      return { ok: false, reason: 'error' };
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_ICON_BYTES) {
      console.error(`Massive publisher logo failed: body too large (${bytes.byteLength} bytes)`);
      return store({ ok: false, reason: 'not_found' });
    }
    // Content-Type is vendor-controlled and gets re-served from OUR origin —
    // allowlist or nothing (never a pass-through, never a guessed default:
    // unlike brand tiles, a favicon URL claiming text/html proves nothing).
    const vendorType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (PUBLISHER_LOGO_CONTENT_TYPES.has(vendorType)) {
      return store({ ok: true, bytes, contentType: vendorType });
    }
    // Observed live 2026-08-16: the bucket serves `.ico` favicons as
    // `application/octet-stream`. An `.ico` PATH with that vendor type is
    // re-served pinned to OUR `image/x-icon` — never the vendor's claim, and
    // never for any other extension (an svg claiming octet-stream stays out).
    if (vendorType === 'application/octet-stream' && new URL(url).pathname.endsWith('.ico')) {
      return store({ ok: true, bytes, contentType: 'image/x-icon' });
    }
    return store({ ok: false, reason: 'not_found' });
  } catch (error) {
    // Never the key, the header, or a URL — message/status only.
    const message = error instanceof Error ? error.message : 'publisher logo fetch failed';
    console.error(`Massive publisher logo failed: ${message}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Holiday calendars do not churn — 6 h keeps the upcoming-calendar call off
 * the 10 s poll path entirely (per-instance, evaporates on cold start).
 */
const CALENDAR_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * A picture assembled while the STORE was unreachable is degraded — it has no
 * horizon, so every stale label loses its timestamp. Caching that for the full
 * 6 h would let the degradation outlive its cause by hours after the database
 * comes back. It still gets a short TTL rather than none: the 10 s poll path
 * must not turn a database blip into a vendor calendar call every tick.
 *
 * Same TTL, second use (2026-08-14): the VENDOR-down fallback state is cached
 * under it too, so a vendor outage stops re-running the store reads and a
 * doomed fetch on every quote poll — while recovery still lands within a
 * minute of the vendor returning.
 */
const CALENDAR_DEGRADED_TTL_MS = 60 * 1000;

interface CalendarState {
  overrides: CalendarOverride[];
  /** Coverage horizon of the durable store — see calendar-store.ts. */
  knownFromISO: string | null;
}

let calendarCache: { at: number; ttlMs: number; state: CalendarState } | null = null;

/**
 * The full calendar picture: the vendor's upcoming feed MERGED with the
 * durable store, plus the store's coverage horizon. The vendor feed is
 * future-only — a closure date drops out the moment it passes — so every
 * successful fetch is written through to the store and the merge keeps past
 * rows alive for the backward scans (`extendedAttribution`,
 * `lastCompletedSessionDateISO`). The 6 h cache holds the MERGED result and
 * the horizon, so the 10 s poll path gains no DB read.
 *
 * Degradation ladder, never a throw: store unreachable → vendor-only rows
 * with a null horizon (labels render timeless, quotes unaffected); vendor
 * unreachable → the stale merged cache, else stored rows alone; both gone →
 * empty overrides and the pure weekday schedule underneath, same as before
 * the store existed. Vendor-failure states are cached for
 * `CALENDAR_DEGRADED_TTL_MS` — long enough to keep the outage off the poll
 * path, short enough that recovery lands within a minute.
 */
async function getCalendarState(): Promise<CalendarState> {
  const nowMs = Date.now();
  if (calendarCache && nowMs - calendarCache.at < calendarCache.ttlMs) return calendarCache.state;

  // Never throws — a read failure IS the empty store with a null horizon.
  const stored = await readStoredCalendar();

  let fetched: CalendarOverride[] | null = null;
  try {
    const body = await massiveFetch('/v1/marketstatus/upcoming');
    const parsed = marketUpcomingSchema.safeParse(body);
    if (!parsed.success) throw new Error('unrecognized response body');
    fetched = mapUpcomingToOverrides(parsed.data);
  } catch (error) {
    // Never the key, the header, or a URL — message/status only.
    const message = error instanceof Error ? error.message : 'calendar fetch failed';
    console.error(`Massive upcoming calendar failed: ${message}`);
  }

  if (fetched === null) {
    // Vendor down: a stale merged cache beats stored-only, which beats
    // empty. Cached briefly (2026-08-14): leaving the cache expired here
    // made EVERY getQuotes — the 10 s poll, every SSE (re)connect — re-run
    // the store reads plus a doomed vendor fetch for the outage's whole
    // duration. The degraded TTL keeps the poll path quiet while letting
    // recovery land within a minute.
    const state = calendarCache?.state ?? {
      overrides: stored.overrides,
      knownFromISO: stored.knownFromISO,
    };
    calendarCache = { at: nowMs, ttlMs: CALENDAR_DEGRADED_TTL_MS, state };
    return state;
  }

  // Write-through (never throws; false = the store recorded nothing). The
  // horizon is the stored one when it exists; on the very first successful
  // capture it starts TODAY (NY date) — and only if the write really landed:
  // claiming coverage the store did not record would be the exact lie the
  // horizon exists to prevent.
  const todayISO = nyDateISOAt(nowMs);
  const persisted = await persistFetchedCalendar(fetched, todayISO);
  const state: CalendarState = {
    overrides: mergeCalendarSources(stored.overrides, fetched),
    knownFromISO: stored.knownFromISO ?? (persisted ? todayISO : null),
  };
  // A picture built without the store (read failed, or the write-through did
  // not land) is held only briefly, so the next call retries the database
  // instead of serving horizonless labels until the 6 h TTL expires.
  const healthy = stored.ok && persisted;
  calendarCache = {
    at: nowMs,
    ttlMs: healthy ? CALENDAR_TTL_MS : CALENDAR_DEGRADED_TTL_MS,
    state,
  };
  return state;
}

/**
 * Upcoming holidays / early closes as market-clock overrides — since the
 * durable-calendar fix (2026-08-13) the MERGED set: vendor future rows plus
 * every stored past row. Same contract, never throws; all existing callers
 * (`getMarketStatus`, session-phase tagging, history coverage) heal from the
 * past-closure blindness automatically.
 */
async function getCalendarOverrides(): Promise<CalendarOverride[]> {
  return (await getCalendarState()).overrides;
}

/**
 * Session status barely changes second to second, and every quote surface
 * asks for it — the page render, `/api/quotes` every 10 s, every SSE
 * (re)connect. 30 s keeps `/v1/marketstatus/now` off that hot path
 * (per-instance, evaporates on cold start — the `calendarCache` pattern).
 *
 * TTL justification (hard condition 3 of the 2026-08-16 live-render plan): a
 * SCHEDULED open/close can never be served stale, because the entry's expiry
 * is capped at the next raw transition instant below — the cache dies at the
 * bell by construction. The only stale case left is an unscheduled ad-hoc
 * halt, bounded at 30 s against a 15-minute-delayed data feed and a 10 s
 * poll cadence. Do not raise it: this ceiling is the whole defense there.
 */
const STATUS_TTL_MS = 30_000;

/**
 * Anything not vouched by a live vendor answer — a fetch/parse failure, or an
 * `unknown` status remapped from the pure clock — is clock-derived and held
 * only briefly, so recovery lands within seconds of the vendor returning
 * while an outage still stays off the 10 s poll path.
 */
const STATUS_DEGRADED_TTL_MS = 10_000;

let statusCache: { expiresAtMs: number; info: MarketSessionInfo } | null = null;

/**
 * Current session + transitions. The vendor's live status is authoritative
 * when it answers (ad-hoc halts are in no calendar); the pure market-clock
 * derivation is the fallback and ALL of the transition math — the status
 * endpoint carries no next-transition timestamp (verified live 2026-08-10).
 *
 * TTL-cached (2026-08-16): the cached `MarketSessionInfo` is safe to serve
 * verbatim inside its window — every time field in it is an absolute epoch
 * instant, so recomputing with a later `nowMs` inside the window yields the
 * identical payload, and the transition cap is precisely what bounds the
 * window to one session phase. Purely global market state: nothing session-,
 * request- or user-derived is ever cached here. `checkKeyHealth` below
 * deliberately bypasses this ladder.
 */
async function getMarketStatus(): Promise<MarketSessionInfo> {
  const nowMs = Date.now();
  if (statusCache !== null && nowMs < statusCache.expiresAtMs) return statusCache.info;
  const overrides = await getCalendarOverrides();

  let status: MarketSessionInfo['status'];
  let vendorAnswered = true;
  try {
    const body = await massiveFetch('/v1/marketstatus/now');
    const parsed = marketStatusNowSchema.safeParse(body);
    if (!parsed.success) throw new Error('unrecognized response body');
    status = mapMarketStatusNow(parsed.data);
    if (status === 'unknown') {
      // Answered, but unrecognized — the remap is clock-derived, so it gets
      // the short TTL too.
      status = statusAt(nowMs, overrides);
      vendorAnswered = false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'status fetch failed';
    console.error(`Massive market status failed: ${message}`);
    status = statusAt(nowMs, overrides);
    vendorAnswered = false;
  }

  // The RAW next boundary, captured BEFORE reconciliation: the expiry cap
  // must use this instant, because `reconcileTransition` can suppress a real
  // boundary that is minutes away — capping on the reconciled value would
  // let the cache outlive a scheduled open or close.
  const rawTransition = nextTransition(nowMs, overrides);

  // The vendor's word and the clock's instant must never contradict each
  // other in one payload ("Open … opens in 17:29:58") — a transition whose
  // kind disagrees with the status is suppressed, not paired.
  const transition = reconcileTransition(status, rawTransition);
  const active = status === 'open' || status === 'early_trading' || status === 'late_trading';

  const info: MarketSessionInfo = {
    status,
    nextTransitionAtMs: transition?.atMs ?? null,
    nextTransitionKind: transition?.kind ?? null,
    pollingResumesAtMs: active ? null : nextSessionActivity(nowMs, overrides),
  };
  const ttlMs = vendorAnswered ? STATUS_TTL_MS : STATUS_DEGRADED_TTL_MS;
  statusCache = {
    // Expire AT the scheduled boundary, never across it — the screen can
    // never say "open" after the bell because of this cache.
    expiresAtMs: Math.min(nowMs + ttlMs, rawTransition?.atMs ?? Infinity),
    info,
  };
  return info;
}

/**
 * One direct probe of `/v1/marketstatus/now` with the configured key — the
 * Settings health surface (2026-08-16, massive-tier0 plan). Deliberately
 * BYPASSES `getMarketStatus`'s degrade-and-cache ladder: that path exists to
 * keep quotes flowing through an outage, which is exactly what makes it
 * useless as a health check — it answers from cache and never says WHY it
 * degraded. Classification off `MassiveHttpError`'s machine-readable status:
 * 401/403 → the key itself is rejected; anything else (timeout, network,
 * 5xx, parse) → the vendor is unreachable. Never throws, and never logs the
 * key, the header, or a URL (this module's standing rule).
 */
async function checkKeyHealth(): Promise<'ok' | 'unauthorized' | 'unreachable'> {
  try {
    await massiveFetch('/v1/marketstatus/now');
    return 'ok';
  } catch (error) {
    if (error instanceof MassiveHttpError && (error.status === 401 || error.status === 403)) {
      return 'unauthorized';
    }
    return 'unreachable';
  }
}

/* ------------------------------------------------------------------ *
 * Options (2026-08-14, options-tracking plan) — additive named exports,
 * deliberately NOT on `QuoteProvider` (frozen by an unrelated in-flight
 * change; the NBP precedent covers a contract living beside it — see
 * options-types.ts). Same vendor discipline as everything above:
 * `server-only`, sequential chunks, bounded same-origin pagination,
 * explicit outcomes over throws for quotes, successes-only TTL caches
 * for the reference lookups. Option quotes are LIVE-ONLY: no
 * `latest_quotes` rows, no `price_snapshots`, no calendar or
 * rolled-prev-close machinery (equity-specific — options have no cached
 * closes to substitute from, and an honest 0.00% pre-open is accepted).
 * ------------------------------------------------------------------ */

const CONTRACTS_PATH = '/v3/reference/options/contracts';

/** The verified per-page maximum on the contracts-reference endpoint. */
const CONTRACTS_PAGE_LIMIT = 1000;

/**
 * Bound on the expiry-enumeration `gte` jumps. The original 12 was sized on
 * AAPL (~8 expiries per page) and silently TRUNCATED dense chains: measured
 * 2026-08-15, one calls+puts page of SPY carried only THREE distinct
 * expiries, so the walk died ~16 iterations short and the wizard simply
 * never offered the later dates.
 *
 * Two changes fix it. The walk now asks for CALLS ONLY — every listed equity
 * expiry has calls, so the date set is identical while the page holds twice
 * as many distinct dates — and the bound is doubled for headroom. Measured
 * after both: SPY's full chain (35 expiries, out to 2028-12-15) converges in
 * 8 iterations. The bound is the defense against a pathological vendor
 * answer, not an expected ceiling.
 */
const MAX_EXPIRY_ITERATIONS = 24;

/** Reference data churns slowly — 1 h, successes only (the searchCache rules). */
const OPTION_REF_TTL_MS = 60 * 60 * 1000;
const MAX_OPTION_REF_CACHE_ENTRIES = 200;

interface ExpirationsCacheEntry {
  at: number;
  expirations: OptionExpiry[];
}

interface StrikesCacheEntry {
  at: number;
  contracts: OptionContractRef[];
}

/** Per-instance, insertion order doubles as eviction order — like searchCache. */
const expirationsCache = new Map<string, ExpirationsCacheEntry>();
const strikesCache = new Map<string, StrikesCacheEntry>();

/**
 * Batch option quotes AND their underlyings' spots over the SAME unified
 * `/v3/snapshot` endpoint the equity path calls — ONE mixed `ticker.any_of`
 * request (option and stock tickers may be mixed, verified live 2026-08-14),
 * through the shared page walker, so a second fetch path to that endpoint
 * never exists. Today's set is 2 contracts + 2 underlyings = 4 tickers in the
 * SAME single request per 60 s poll, not a second one; the spots therefore
 * need no cache of their own and are exactly as fresh (and as 15-min delayed)
 * as every other price in the app.
 *
 * The `getQuotes` discipline verbatim: sequential `MAX_BATCH` chunks, a failed
 * chunk degrades to explicit error outcomes (never a thrown batch), and every
 * requested OPTION ticker the vendor did not return reconciles to `not_found`
 * — which is how an EXPIRED contract stays a renderable card instead of a
 * dropped row. A missing SPOT is simply absent: the model mark then falls back
 * to the traded price, which is a degradation, not an error. A chunk boundary
 * may split a contract from its underlying; harmless by construction, because
 * results merge into two flat maps rather than being paired positionally.
 */
export async function getOptionSnapshots(
  optionTickers: readonly string[],
  underlyings: readonly string[] = [],
): Promise<{ quotes: Map<string, OptionQuoteOutcome>; spots: Map<string, string> }> {
  const outcomes = new Map<string, OptionQuoteOutcome>();
  const spots = new Map<string, string>();
  if (optionTickers.length === 0) return { quotes: outcomes, spots };

  // Reconciliation index: vendor tickers come back uppercase; keep the
  // caller's exact strings as the map keys. Options and underlyings share it —
  // the two namespaces cannot collide (`O:` prefix).
  const requestedByUpper = new Map<string, string>();
  for (const ticker of optionTickers) requestedByUpper.set(ticker.toUpperCase(), ticker);
  for (const symbol of underlyings) requestedByUpper.set(symbol.toUpperCase(), symbol);

  const now = new Date();
  const requested = [...optionTickers, ...underlyings];

  // Sequential chunks, deliberately — one user, no fan-out.
  for (let i = 0; i < requested.length; i += MAX_BATCH) {
    const chunk = requested.slice(i, i + MAX_BATCH);

    let results: MixedSnapshotResult[];
    try {
      results = await fetchPagedResults(
        'option snapshot',
        '/v3/snapshot',
        snapshotParams(chunk),
        (body) => {
          const parsed = mixedSnapshotResponseSchema.safeParse(body);
          return parsed.success ? parsed.data : null;
        },
      );
    } catch (error) {
      // Never the key, the header, or a URL — message/status only.
      const message = error instanceof Error ? error.message : 'snapshot fetch failed';
      console.error(`Massive option snapshot chunk failed (${chunk.length} tickers): ${message}`);
      for (const ticker of chunk) {
        // Only option tickers carry an outcome; a missing spot is absent.
        if (ticker.toUpperCase().startsWith('O:')) {
          outcomes.set(ticker, { ok: false, symbol: ticker, reason: 'error', message });
        }
      }
      continue;
    }

    for (const raw of results) {
      // Route by asset class: options map exactly as before, everything else
      // is read as an underlying spot. The OCC `O:` prefix is the tie-breaker
      // when `type` is absent — a per-result `error` entry carries no `type`,
      // and an option's failure must stay an option OUTCOME (a card), never a
      // silently dropped spot.
      const isOption =
        raw.type === 'options' || (raw.ticker?.toUpperCase().startsWith('O:') ?? false);
      if (!isOption) {
        const spot = mapUnderlyingSpot(raw);
        if (spot === null) continue;
        const key = requestedByUpper.get(spot.symbol.toUpperCase());
        if (key !== undefined) spots.set(key, spot.price);
        continue;
      }

      const outcome = mapOptionSnapshotResult(raw, {
        delaySeconds: DELAY_SECONDS,
        source: NAME,
        now,
      });
      if (!outcome) continue; // no ticker — unusable for reconciliation
      const key = outcome.ok ? outcome.quote.ticker : outcome.symbol;
      const optionKey = requestedByUpper.get(key.toUpperCase());
      if (optionKey !== undefined) outcomes.set(optionKey, outcome);
    }
  }

  for (const ticker of optionTickers) {
    if (!outcomes.has(ticker)) {
      outcomes.set(ticker, { ok: false, symbol: ticker, reason: 'not_found' });
    }
  }

  return { quotes: outcomes, spots };
}

/**
 * Daily option bars — a thin delegate to the ONE aggregate-bars fetch path
 * (`fetchAggregates`), exactly like the equity `getDailyCloses` alias: no
 * second `/v2/aggs` path ever exists. The OCC ticker's colon is
 * percent-encoded by `aggsPath`'s `seg()`, and `mapAggsResults` keeps the
 * sanctioned JSON-number→`dec()` crossing where it lives. A bar exists for a
 * date iff the contract traded that date (verified 2026-08-15) — which makes
 * the newest bar both the freshest print and the authoritative last-traded
 * date. Throws on vendor failure; the caller (`close-sync.ts`) degrades
 * per-ticker.
 */
export async function getOptionDailyCloses(
  ticker: string,
  from: string,
  to: string,
): Promise<Candle[]> {
  return fetchAggregates(ticker, { multiplier: 1, timespan: 'day', from, to });
}

/**
 * Every non-expired expiration date for an underlying, ascending. One
 * contracts page does NOT cover all expiries (verified 2026-08-14: one AAPL
 * page at limit=1000 spanned ~8), so enumeration re-queries with
 * `expiration_date.gte = nextExpirationQueryDate(lastSeen)` until a page
 * yields no new expiry — bounded at {@link MAX_EXPIRY_ITERATIONS}. Throws on
 * vendor failure; the Server Action degrades it to a retryable state.
 */
export async function listOptionExpirations(underlying: string): Promise<OptionExpiry[]> {
  const key = underlying.toUpperCase();
  const now = Date.now();

  const hit = expirationsCache.get(key);
  if (hit) {
    if (now - hit.at < OPTION_REF_TTL_MS) return hit.expirations;
    expirationsCache.delete(key);
  }

  const dates = new Set<string>();
  let gte: string | undefined;

  for (let i = 0; i < MAX_EXPIRY_ITERATIONS; i++) {
    const params = optionContractsParams(underlying, {
      expired: false,
      // Calls only: the date set is identical (listed equity options come in
      // call/put pairs) but each page carries twice as many distinct dates,
      // which is what keeps dense chains from truncating. See
      // MAX_EXPIRY_ITERATIONS.
      contractType: 'call',
      limit: CONTRACTS_PAGE_LIMIT,
      sort: 'expiration_date',
      order: 'asc',
      ...(gte !== undefined ? { expirationDateGte: gte } : {}),
    });
    const body = await massiveFetch(CONTRACTS_PATH, params);
    const parsed = optionContractsResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('Massive option contracts: unrecognized response body');
    }

    const before = dates.size;
    let newest: string | undefined;
    for (const item of parsed.data.results ?? []) {
      const date = item.expiration_date;
      if (!date) continue;
      dates.add(date);
      // Sorted ascending by the query, but tracked defensively anyway.
      if (newest === undefined || date > newest) newest = date;
    }

    // An empty page or one with no NEW expiry means the chain is exhausted.
    if (newest === undefined || dates.size === before) break;
    gte = nextExpirationQueryDate(newest);
  }

  const expirations = [...dates].sort().map((date) => ({ date }));

  if (expirationsCache.size >= MAX_OPTION_REF_CACHE_ENTRIES) {
    const oldest = expirationsCache.keys().next().value;
    if (oldest !== undefined) expirationsCache.delete(oldest);
  }
  expirationsCache.set(key, { at: now, expirations });

  return expirations;
}

/**
 * Every contract for one (underlying, expiration, call/put) cell, strikes
 * ascending — the wizard's final picking stage. One query, following
 * `next_url` under the shared bounded same-origin walk. Throws on vendor
 * failure; the Server Action degrades it.
 */
export async function listOptionStrikes(
  underlying: string,
  expirationDate: string,
  contractType: 'call' | 'put',
): Promise<OptionContractRef[]> {
  const key = `${underlying.toUpperCase()}|${expirationDate}|${contractType}`;
  const now = Date.now();

  const hit = strikesCache.get(key);
  if (hit) {
    if (now - hit.at < OPTION_REF_TTL_MS) return hit.contracts;
    strikesCache.delete(key);
  }

  const items = await fetchPagedResults(
    'option contracts',
    CONTRACTS_PATH,
    optionContractsParams(underlying, {
      contractType,
      expirationDate,
      limit: CONTRACTS_PAGE_LIMIT,
      sort: 'strike_price',
      order: 'asc',
    }),
    (body) => {
      const parsed = optionContractsResponseSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    },
  );

  const contracts = mapOptionContracts(items);

  if (strikesCache.size >= MAX_OPTION_REF_CACHE_ENTRIES) {
    const oldest = strikesCache.keys().next().value;
    if (oldest !== undefined) strikesCache.delete(oldest);
  }
  strikesCache.set(key, { at: now, contracts });

  return contracts;
}

/** Calendar days around the parsed expiry the near-miss window covers. */
const NEARBY_EXPIRY_WINDOW_DAYS = 45;

/**
 * Strike band around the parsed strike, as a fraction of it. Narrowed from
 * 0.5×–1.5× on 2026-08-15: the walk is sorted by expiration ascending and
 * bounded at MAX_PAGES, so on a dense chain a band that wide could fill every
 * page with EARLIER expiries and stop before reaching the date the user
 * actually mistyped — offering "nearest" contracts that were all on the wrong
 * side. A ±20% band is still far wider than any plausible OCR slip (a
 * misread digit, a transposition) while cutting the row count roughly
 * two-and-a-half fold.
 */
const NEARBY_STRIKE_LOW = '0.8';
const NEARBY_STRIKE_HIGH = '1.2';

/**
 * 'YYYY-MM-DD' ± delta calendar days — pure UTC arithmetic on date COUNTS,
 * not money; DST cannot touch a UTC day increment (the
 * `nextExpirationQueryDate` rationale).
 */
function addCalendarDays(dateISO: string, delta: number): string {
  const [y, m, d] = dateISO.split('-');
  const shifted = new Date(
    Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10) + delta),
  );
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * The screenshot-import verification's near-miss window: every listed
 * contract of one (underlying, call/put) pair with an expiry within ±45
 * calendar days of the parsed date and a strike between 0.5× and 1.5× the
 * parsed strike. ONE direct filtered query — NEVER a chain walk: the
 * verification path deliberately avoids `listOptionExpirations`, whose
 * bounded enumeration can truncate dense chains (SPY-class). Uncached by
 * design: a rare, user-initiated path where staleness would cost more than
 * the one extra call. Throws on vendor failure; the Server Action degrades
 * it.
 */
export async function listNearbyOptionContracts(
  underlying: string,
  contractType: 'call' | 'put',
  aroundExpiryISO: string,
  aroundStrike: string,
): Promise<OptionContractRef[]> {
  // Decimal window bounds — `.toFixed()` (no args) renders the full value
  // without exponent notation, so URLSearchParams always gets a plain
  // decimal string.
  const strikeDec = dec(aroundStrike);
  const items = await fetchPagedResults(
    'option contracts (nearby)',
    CONTRACTS_PATH,
    optionContractsParams(underlying, {
      contractType,
      expirationDateGte: addCalendarDays(aroundExpiryISO, -NEARBY_EXPIRY_WINDOW_DAYS),
      expirationDateLte: addCalendarDays(aroundExpiryISO, NEARBY_EXPIRY_WINDOW_DAYS),
      strikePriceGte: strikeDec.times(dec(NEARBY_STRIKE_LOW)).toFixed(),
      strikePriceLte: strikeDec.times(dec(NEARBY_STRIKE_HIGH)).toFixed(),
      limit: CONTRACTS_PAGE_LIMIT,
      sort: 'expiration_date',
      order: 'asc',
    }),
    (body) => {
      const parsed = optionContractsResponseSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    },
  );

  return mapOptionContracts(items);
}

/* ------------------------------------------------------------------ *
 * News (2026-08-16, watchlist-news-module plan) — an additive named
 * export, deliberately NOT on `QuoteProvider` (that contract is
 * quotes/candles/search; the NBP and options precedents cover a
 * server-mediated sibling). `reference/news` appears in THIS file and
 * nowhere else — grep-able on purpose, because the vendor has no
 * working fetch-by-id (`?id=` silently returns the newest article,
 * verified live 2026-08-16): any second call site would be a place a
 * wrong-article bug could grow back.
 * ------------------------------------------------------------------ */

const NEWS_PATH = '/v2/reference/news';

/**
 * Recent news for ONE symbol — `ticker=<SYMBOL>` + `limit`, the two params
 * verified live 2026-08-16 (`ticker.any_of`/`tickers`/`ticker.in` are
 * silently ignored, and a comma list on `ticker` returns 0 results — never
 * re-join symbols; the caller fans out per symbol instead). Rides the shared
 * bounded same-origin page walker with an early stop at `limit`: the news
 * cursor is always present, so an unbounded walk would fetch `MAX_PAGES`
 * full pages every refresh. Vendor ORDERING IS NOT TRUSTED (observed
 * newest-first, but never promised): the feed sorts by `published_at` in SQL
 * after persisting. Throws on failure; the caller (`src/lib/news/feed.ts`,
 * the only call site) degrades to the persisted rows.
 */
export async function getNewsArticles(symbol: string, limit: number): Promise<NewsArticle[]> {
  if (symbol.trim() === '') return [];

  const items = await fetchPagedResults(
    'news',
    NEWS_PATH,
    newsParams(symbol, limit),
    (body) => {
      const parsed = newsResponseSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    },
    limit,
  );

  return mapNewsResults(items);
}

/* ------------------------------------------------------------------ *
 * Dividends (2026-08-16, dividends plan) — cash-dividend history over
 * `/v3/reference/dividends` (entitlement VERIFIED LIVE 2026-08-16 with
 * the real key). Rides the shared bounded same-origin page walker; the
 * mapping (and the one sanctioned `cash_amount` number→dec() crossing)
 * lives in massive-mapping.ts. Throws on vendor failure — the dividends
 * sync degrades per instrument, exactly like the history backfill.
 * ------------------------------------------------------------------ */

async function getDividends(symbol: string, sinceExDateISO: string): Promise<DividendEvent[]> {
  const items = await fetchPagedResults(
    'dividends',
    '/v3/reference/dividends',
    dividendsParams(symbol, sinceExDateISO),
    (body) => {
      const parsed = dividendsResponseSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    },
  );
  return mapDividendResults(items);
}

export const massiveProvider: QuoteProvider = {
  name: NAME,
  delaySeconds: DELAY_SECONDS,
  getQuotes,
  getAggregates,
  getDailyCloses,
  searchSymbols,
  getDividends,
  getMarketStatus,
  getCalendarOverrides,
  getBrandingIcon,
  getTickerProfile,
  streamPrices,
  checkKeyHealth,
};
