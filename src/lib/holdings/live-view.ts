import 'server-only';

import { asc, eq } from 'drizzle-orm';

import { db, instruments, portfolios, transactions } from '@/lib/db';
import { getCurrentFxRateToPln } from '@/lib/fx/nbp';
import {
  nextSessionActivity,
  nextTransition,
  statusAt,
} from '@/lib/market-data/market-clock';
import { massiveProvider } from '@/lib/market-data/massive';
import type { MarketSessionInfo } from '@/lib/market-data/provider';
import {
  persistQuotes,
  persistThrottleKey,
  readCachedQuotes,
  type CachedQuote,
  type PersistableQuote,
} from '@/lib/market-data/quote-cache';
import { fmtMoney, fmtQuantity } from '@/lib/money';
import {
  computePositions,
  displayablePositions,
  type EngineTransaction,
} from '@/lib/position-engine';
import type { TrendSlot } from '@/lib/trend/day-trend';
import { fetchHoldingsTotalTrendBestEffort, fetchTrendsBestEffort } from '@/lib/trend/load';

import {
  composeLivePayload,
  type HoldingQuote,
  type HoldingsInputs,
  type LivePayload,
} from './live-payload';
import { hasPollableSymbols } from './poll-policy';

/**
 * The shared Holdings LOADER — the ONE data walk the page (initial render),
 * `GET /api/quotes` (the 10 s poll) and `GET /api/quotes/stream` (the SSE
 * baseline on every (re)connect) all run: DB join → provider quotes → NBP FX
 * → market status. Composition into the serializable payload is pure and
 * lives in `live-payload.ts` so the stream route can recompose per tick
 * without re-hitting the DB or FX; `getHoldingsView()` keeps its original
 * API and output for the page and the poll route.
 *
 * The split is by volatility: `staticHoldings` carries what only a mutation
 * can change (identity, quantities, cost basis, transaction rows) and ships
 * once with the page; `live` is the serializable payload the client swaps on
 * every poll response or stream event. Every money/percent field in either
 * half is a pre-formatted display string — Decimal never crosses the client
 * boundary.
 *
 * Best-effort discipline preserved verbatim from the original page: quote,
 * FX and status failures degrade the payload (cost-only cards, "—" summary,
 * derived market status), never throw.
 */

// Compatibility re-exports: the payload types moved to the isomorphic
// `live-payload.ts` (client hooks import them there without touching this
// server-only module); existing type-only imports keep working.
export type {
  HoldingQuote,
  HoldingsInputs,
  LiveFigure,
  LiveHolding,
  LiveMarket,
  LivePayload,
  LiveSummary,
} from './live-payload';

export interface StaticHolding {
  instrumentId: string;
  symbol: string;
  displayName: string;
  /** Instrument trading currency, for the avg-cost label. */
  currency: string;
  quantity: string;
  /** Null when quantity is zero (oversold-at-zero rows). */
  avgCost: string | null;
  costBasisPLN: string;
  oversold: boolean;
  /**
   * The five-day trend strip, oldest session first. Absent when the instrument
   * has no stored history yet, or when the history read failed — both render
   * as no strip, never as a fabricated flat week.
   */
  trend?: TrendSlot[];
}

/**
 * The per-mutation half of one portfolio scope: its identity, how many
 * transactions it holds (the context row's meta line) and the same static
 * holdings shape the whole-portfolio view uses, recomputed over that
 * portfolio's rows alone. Pairs by `id` with `LivePayload.scopes`.
 */
export interface StaticScope {
  id: string;
  name: string;
  /** Integer row count — not money, a plain number is correct here. */
  txCount: number;
  staticHoldings: StaticHolding[];
}

export interface HoldingsView {
  staticHoldings: StaticHolding[];
  /** Every portfolio in display order, empty ones included. */
  scopes: StaticScope[];
  live: LivePayload;
}

/** One joined transaction row — the engine input plus its portfolio labels. */
export interface HoldingsSourceRow extends EngineTransaction {
  portfolioId: string;
  portfolioName: string;
}

export interface LoadedHoldings {
  /** Raw joined rows, for the static (per-mutation) half of the view. */
  rows: HoldingsSourceRow[];
  inputs: HoldingsInputs;
  quotes: Map<string, HoldingQuote>;
}

/**
 * Live quotes for a symbol set, best-effort: one batch call for every
 * distinct symbol. Per-symbol failures arrive as `ok: false` outcomes (a
 * stored non-US symbol degrades to `not_found` — expected, not an error); a
 * wholesale throw leaves the map empty and the view renders cost-only.
 * Extracted move-only from `loadHoldingsInputs` so any loader that prices a
 * user-scoped symbol set shares ONE vendor discipline.
 *
 * `pollable` is the structural verdict for the client's poll gate. Optimistic
 * default: a wholesale failure is transient by definition and must NOT read
 * as "nothing pollable" — that would kill the 10 s cadence for the session.
 *
 * `refs` (symbol → instrumentId, 2026-08-16 massive-tier0 plan) opts a
 * caller into the durable quote cache: successful quotes are persisted
 * (awaited, throttled inside quote-cache.ts), and symbols whose
 * outcome was a TRANSIENT failure (`reason: 'error'`, or a wholesale throw)
 * come back in `cached` from the last saved rows — display-only fallback
 * material. `not_found`/`unsupported` symbols deliberately get no cached
 * entry: their absence is structural, not an outage. Cache I/O is
 * best-effort end to end — it never degrades the live quotes.
 */
export async function fetchQuotesBestEffort(
  symbols: readonly string[],
  refs?: ReadonlyMap<string, string>,
): Promise<{
  quotes: Map<string, HoldingQuote>;
  pollable: boolean;
  cached: Map<string, CachedQuote>;
}> {
  let pollable = symbols.length > 0;
  const quotes = new Map<string, HoldingQuote>();
  const transientFailures = new Set<string>();
  try {
    if (symbols.length > 0) {
      const outcomes = await massiveProvider.getQuotes(symbols);
      pollable = hasPollableSymbols(outcomes.values());
      const persistable: PersistableQuote[] = [];
      for (const [symbol, outcome] of outcomes) {
        if (!outcome.ok) {
          if (outcome.reason === 'error') transientFailures.add(symbol);
          continue;
        }
        quotes.set(symbol, {
          price: outcome.quote.price,
          // Massive is US-markets-only end to end, so its prices are USD by
          // construction. Stamping the honest vendor currency lets the
          // engine's guard reject a quote for a non-USD instrument instead
          // of applying the wrong FX rate.
          currency: 'USD',
          prevClose: outcome.quote.prevClose,
          dayChangeAmt: outcome.quote.dayChangeAmt,
          dayChangePct: outcome.quote.dayChangePct,
          // The session stats pass-through (day-stats row); dayVolume is a
          // count, not money — it rides as a plain number.
          dayOpen: outcome.quote.dayOpen,
          dayHigh: outcome.quote.dayHigh,
          dayLow: outcome.quote.dayLow,
          dayVolume: outcome.quote.dayVolume,
          vwap: outcome.quote.vwap,
          extendedChangePct: outcome.quote.extendedChangePct,
          extendedKind: outcome.quote.extendedKind,
          extendedEndedAtMs: outcome.quote.extendedEndedAtMs,
          extendedLive: outcome.quote.extendedLive,
        });
        const instrumentId = refs?.get(symbol);
        if (instrumentId !== undefined) {
          persistable.push({ instrumentId, quote: outcome.quote });
        }
      }
      if (persistable.length > 0) {
        // AWAITED, deliberately (2026-08-16 gap fix, was fire-and-forget): a
        // floating promise inside an RSC render or route handler can be
        // frozen with the instance the moment the response is sent — on a
        // cold start that drops the FIRST write, exactly the one the cache
        // exists for. `await` beats `after()` here because this loader also
        // runs under the long-lived SSE stream routes, where "after the
        // response" is minutes away or never; the cost is one throttled
        // insert per 60 s per surface, and persistQuotes never throws.
        //
        // The throttle key comes from the REQUESTED refs, not from
        // `persistable` — under a vendor flap the successful subset changes
        // shape every poll, and a subset-derived key would look cold each
        // time and write on every tick.
        await persistQuotes(persistable, persistThrottleKey(refs?.values() ?? []));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'quote fetch failed';
    console.error(`Quote lookup failed: ${message}`);
    quotes.clear();
    for (const symbol of symbols) transientFailures.add(symbol);
  }

  let cached = new Map<string, CachedQuote>();
  if (refs !== undefined && transientFailures.size > 0) {
    const failedRefs = new Map<string, string>();
    for (const symbol of transientFailures) {
      const instrumentId = refs.get(symbol);
      if (instrumentId !== undefined) failedRefs.set(symbol, instrumentId);
    }
    // Best-effort inside — a cache read failure yields the empty map.
    cached = await readCachedQuotes(failedRefs);
  }
  return { quotes, pollable, cached };
}

/**
 * Market status, best-effort: the provider degrades internally, but even a
 * throw here must not take a page down — the pure calendar always has an
 * answer. Extracted move-only from `loadHoldingsInputs` (same sharing
 * rationale as `fetchQuotesBestEffort`).
 */
export async function fetchMarketStatusBestEffort(): Promise<MarketSessionInfo> {
  try {
    return await massiveProvider.getMarketStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'status lookup failed';
    console.error(`Market status lookup failed: ${message}`);
    const nowMs = Date.now();
    const status = statusAt(nowMs, []);
    const transition = nextTransition(nowMs, []);
    const active = status === 'open' || status === 'early_trading' || status === 'late_trading';
    return {
      status,
      nextTransitionAtMs: transition?.atMs ?? null,
      nextTransitionKind: transition?.kind ?? null,
      pollingResumesAtMs: active ? null : nextSessionActivity(nowMs, []),
    };
  }
}

/**
 * Latest published NBP mid per distinct non-PLN currency — the VALUATION
 * rate, never the D-1 tax rate. The inner loop is sequential on purpose: the
 * set is tiny at one user and the provider discipline forbids fan-out.
 * Never throws — failures skip the currency (or clear the map wholesale);
 * those cards show cost-only PLN figures.
 */
async function fetchFxRatesBestEffort(currencies: readonly string[]): Promise<Map<string, string>> {
  const fxRates = new Map<string, string>();
  try {
    for (const currency of currencies) {
      const result = await getCurrentFxRateToPln(currency);
      if (result.ok) fxRates.set(currency, result.rate);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'fx lookup failed';
    console.error(`Holdings FX lookup failed: ${message}`);
    fxRates.clear();
  }
  return fxRates;
}

/**
 * The impure half: DB join, provider quotes, NBP FX and market status —
 * everything a payload composition needs, loaded once. The stream route
 * calls this on every (re)connect, which IS the baseline refresh: prevClose,
 * market status and FX are never older than one stream lifetime.
 *
 * Parallelized (2026-08-16 live-render plan) at two levels: the two DB
 * queries are independent of each other and run together; quotes, FX and
 * market status are mutually independent and run together — but all three
 * start only AFTER the transaction rows resolved, because the quote symbol
 * set and the FX currency set are DERIVED from those rows. That dependency
 * is real and must survive any future reshuffle.
 */
export async function loadHoldingsInputs(userId: string): Promise<LoadedHoldings> {
  // The portfolio list is its OWN query, not a by-product of the transaction
  // join: a portfolio with no transactions still needs its chip and its
  // (empty) scope. `sortOrder` is the user's own drag/menu ordering.
  const [portfolioRows, rawRows] = await Promise.all([
    db
      .select({ id: portfolios.id, name: portfolios.name })
      .from(portfolios)
      .where(eq(portfolios.userId, userId))
      .orderBy(asc(portfolios.sortOrder), asc(portfolios.createdAt)),
    db
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
        portfolioId: transactions.portfolioId,
        portfolioName: portfolios.name,
      })
      .from(transactions)
      .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
      .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
      .where(eq(portfolios.userId, userId)),
  ]);

  // `side` is checked (never cast wholesale) — the DB only ever receives
  // 'buy' | 'sell' through the validated action, but the column type is text.
  const rows: HoldingsSourceRow[] = rawRows.map((r) => ({
    ...r,
    side: r.side === 'sell' ? 'sell' : 'buy',
  }));

  // Live quotes, best-effort — see `fetchQuotesBestEffort`. The refs opt this
  // walk into the durable quote cache: good quotes persist, and a transient
  // vendor failure fills `cached` with the last saved prices for the
  // display-only fallback.
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const refs = new Map(rows.map((r) => [r.symbol, r.instrumentId]));
  const currencies = [...new Set(rows.map((r) => r.currency))].filter((c) => c !== 'PLN');

  // `Promise.all` is safe here ONLY because every member is a documented
  // never-throw best-effort function (each degrades to an empty map or a
  // clock-derived status internally). A future member that can throw would
  // break the whole-payload degradation contract — cost-only cards, "—"
  // summary, derived market status — by turning one leg's failure into a
  // whole-page failure. Keep that invariant, or switch to allSettled.
  const instrumentIds = [...new Set(rows.map((r) => r.instrumentId))];

  // The summed book's strip needs quantities, not prices: the engine's
  // quantity walk over the raw rows (no quotes) is exactly that.
  const totalPositions = computePositions(rows)
    .filter((position) => position.quantity.greaterThan(0))
    .map((position) => ({
      key: position.instrumentId,
      units: position.quantity.toString(),
      currency: position.currency,
    }));

  const [{ quotes, pollable, cached }, fxRates, market, trends, summaryTrend] = await Promise.all([
    fetchQuotesBestEffort(symbols, refs),
    fetchFxRatesBestEffort(currencies),
    fetchMarketStatusBestEffort(),
    fetchTrendsBestEffort(instrumentIds),
    fetchHoldingsTotalTrendBestEffort(totalPositions),
  ]);

  return {
    rows,
    inputs: {
      engineTxs: rows,
      fxRates,
      market,
      hasPollableSymbols: pollable,
      portfolios: portfolioRows,
      cachedQuotes: cached,
      trends,
      summaryTrend,
    },
    quotes,
  };
}

/**
 * The pure half of `getHoldingsView`: compose the serializable view from an
 * already-loaded walk. Split out (per-portfolio-groups plan) so the ticker
 * page can hold the raw `quotes` / `fxRates` maps AND the composed view from
 * ONE `loadHoldingsInputs` walk — no second DB join, vendor batch or NBP pass.
 */
export function composeHoldingsView(loaded: LoadedHoldings): HoldingsView {
  const { inputs, quotes } = loaded;

  // Transaction rows are deliberately NOT loaded here anymore (M5): the list
  // no longer renders them — the ticker page (`/holdings/[ticker]`) has its
  // own loader — and dropping them shrinks the Holdings HTML payload.
  const toStatic = (txs: typeof inputs.engineTxs): StaticHolding[] =>
    // Open positions plus oversold-at-zero ones — the oversold badge must stay
    // reachable in exactly the case it exists for (sell entered before its buy).
    displayablePositions(computePositions(txs, quotes, inputs.fxRates)).map((p) => ({
      instrumentId: p.instrumentId,
      symbol: p.symbol,
      displayName: p.displayName,
      currency: p.currency,
      quantity: fmtQuantity(p.quantity),
      avgCost: p.avgCost === null ? null : fmtMoney(p.avgCost, p.currency),
      costBasisPLN: fmtMoney(p.costBasisPLN, 'PLN'),
      oversold: p.oversold,
      trend: inputs.trends?.get(p.instrumentId),
    }));

  // Per-portfolio slices via the SAME builder as the total — a scoped
  // quantity or avg cost can never disagree with the all-portfolios figure
  // it is a part of.
  const scopes: StaticScope[] = (inputs.portfolios ?? []).map((portfolio) => {
    const txs = inputs.engineTxs.filter((t) => t.portfolioId === portfolio.id);
    return {
      id: portfolio.id,
      name: portfolio.name,
      txCount: txs.length,
      staticHoldings: toStatic(txs),
    };
  });

  return {
    staticHoldings: toStatic(inputs.engineTxs),
    scopes,
    live: composeLivePayload(inputs, quotes),
  };
}

export async function getHoldingsView(userId: string): Promise<HoldingsView> {
  return composeHoldingsView(await loadHoldingsInputs(userId));
}
