import 'server-only';

import { and, eq } from 'drizzle-orm';

import { listTargets } from '@/lib/alerts/target-store';
import { targetStatusFor } from '@/lib/alerts/target-proximity';
import type {
  PriceTargetContract,
  TargetStatusContract,
} from '@/lib/api/contracts/price-targets';
import { db, instruments, portfolios, transactions, watchlist } from '@/lib/db';
import { hasDividendPayments } from '@/lib/dividends/store';
import { getDailyBars, type HistoryInstrument } from '@/lib/history/price-history';
import type { HoldingDetailData } from '@/lib/holdings/types';
import {
  dayStatsFigures,
  quoteFigures,
  type DayStatsFigures,
  type LiveHolding,
} from '@/lib/holdings/live-payload';
import { composeHoldingsView, fetchQuotesBestEffort } from '@/lib/holdings/live-view';
import { loadInstrumentInputs } from '@/lib/holdings/instrument-view';
import { computePortfolioGroups, type PortfolioGroupRow } from '@/lib/holdings/portfolio-groups';
import { composeAbout, week52Window, type AboutFigures } from '@/lib/instruments/about';
import { syncInstrumentProfiles } from '@/lib/instruments/profile';
import { resolveInstrumentForBrowsing } from '@/lib/instruments/resolve';
import { nyDateISOAt } from '@/lib/market-data/market-clock';
import { dec, fmtMoney } from '@/lib/money';
import { listTransactions, type TransactionRow } from '@/lib/transactions/mutations';

/**
 * The instrument screen's payload for the native client.
 *
 * Figure parity is STRUCTURAL, not a promise: this module runs the same
 * `loadInstrumentInputs` narrow walk, the same `composeHoldingsView`, the
 * same `computePortfolioGroups` and the same `quoteFigures` over the same
 * rows. Any figure that disagreed would have to come from one of those.
 *
 * Deliberately NOT every related surface: the dividend ROWS and the
 * options-underlying branch stay OUT of this payload — dividends are their
 * own endpoint the client already speaks, so folding the list in would make
 * every instrument open pay for data a user may never scroll to; the options
 * branch is a whole alternative identity resolution. `hasDividends` is the
 * one exception: a cheap existence check, not the rows, so the client can
 * gate the Dividends link without a second round trip.
 *
 * Ownership decides the PAYLOAD, not whether there is one. Transactions give
 * a position, groups and rows; the watchlist gives identity plus figures; and
 * since browsing, any symbol the directory knows gives the same read-only view
 * with `owned` and `watched` both false. Only a ticker nothing has heard of is
 * `null` here and a 404 at the route.
 */

/**
 * The loader's own precise type. It MIRRORS `instrumentResponseSchema` but is
 * stated in terms of the types the composers actually produce (`currency` is
 * a plain string here, because that is what the column is) — the schema then
 * checks the payload at the boundary in `instrument-detail.test.ts`. Aliasing
 * the contract type instead would force a cast, and a cast is exactly the
 * thing that lets a shape drift silently.
 */
export interface InstrumentDetail {
  instrumentId: string;
  symbol: string;
  displayName: string;
  currency: string;
  exchange: string;
  owned: boolean;
  watched: boolean;
  /** True when the user has at least one dividend payment for it — gates the
   *  native client's Dividends link. */
  hasDividends: boolean;
  position: HoldingDetailData | null;
  price: LiveHolding['price'];
  cachedPrice: LiveHolding['cachedPrice'];
  dayPct: LiveHolding['dayPct'];
  extended: LiveHolding['extended'];
  dayStats: DayStatsFigures;
  about: AboutFigures;
  groups: ReturnType<typeof computePortfolioGroups>;
  transactions: TransactionRow[];
  /** THIS user's price targets on the instrument — empty when none. */
  priceTargets: PriceTargetContract[];
  /** The proximity readout above the target rows — the exact calculation the
   *  watchlist tiles run (`target-proximity.ts`). Null when no lines. */
  targetStatus: TargetStatusContract | null;
}

/**
 * The one distance base this payload may use: the raw quote when its
 * currency matches the instrument, else the cached row under the same guard,
 * else null (the status then reads "no current price"). Shared by both
 * branches so owned and browsed stocks measure identically.
 */
function currentPriceFor(
  quote: { price: string; currency: string } | undefined,
  cached: { price: string; currency: string } | undefined,
  currency: string,
): string | null {
  if (quote && quote.currency === currency) return quote.price;
  if (cached && cached.currency === currency) return cached.price;
  return null;
}

export async function loadInstrumentDetail(
  userId: string,
  symbol: string,
): Promise<InstrumentDetail | null> {
  // Ownership-scoped rows for THIS instrument. The join to portfolios on the
  // user id is what makes ownership impossible to forget.
  const rawRows = await db
    .select({
      id: transactions.id,
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      exchange: instruments.exchange,
      currency: instruments.currency,
      side: transactions.side,
      quantity: transactions.quantity,
      price: transactions.price,
      fees: transactions.fees,
      fxRateToBase: transactions.fxRateToBase,
      tradeDate: transactions.tradeDate,
      createdAt: transactions.createdAt,
      portfolioId: portfolios.id,
      portfolioName: portfolios.name,
      portfolioSortOrder: portfolios.sortOrder,
      portfolioCreatedAt: portfolios.createdAt,
    })
    .from(transactions)
    .innerJoin(
      portfolios,
      and(eq(transactions.portfolioId, portfolios.id), eq(portfolios.userId, userId)),
    )
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(eq(instruments.symbol, symbol));

  if (rawRows.length === 0) return unownedDetail(userId, symbol);

  const { instrumentId, displayName, exchange, currency } = rawRows[0];

  // Engine-shaped rows, `side` checked per row (never cast wholesale — the
  // column type is text).
  const engineRows: PortfolioGroupRow[] = rawRows.map((r) => ({
    ...r,
    side: r.side === 'sell' ? 'sell' : 'buy',
  }));

  // ONE data walk serves both the composed figures and the raw quote/FX maps
  // the per-portfolio groups price with, so the group figures cannot disagree
  // with the header by construction. The transaction list is a separate,
  // independent read — run them together.
  const [loaded, txRows, dividends, aboutInputs, priceTargets] = await Promise.all([
    loadInstrumentInputs(engineRows),
    listTransactions(userId, { symbol }),
    hasDividendPayments(userId, instrumentId),
    (async () => {
      await syncInstrumentProfiles([instrumentId]);
      return readAboutBundle({ id: instrumentId, symbol, currency });
    })(),
    listTargets(userId, instrumentId),
  ]);

  const view = composeHoldingsView(loaded);
  const holding = view.staticHoldings.find((h) => h.instrumentId === instrumentId);
  const live = view.live.holdings.find((h) => h.instrumentId === instrumentId);

  // Per-portfolio summaries: the engine runs over each portfolio's own rows,
  // priced with the SAME quote + FX maps the header figures used.
  const groups = computePortfolioGroups(engineRows, loaded.quotes, loaded.inputs.fxRates);

  // A fully-sold instrument still has rows to show but no displayable
  // position — `displayablePositions` drops it, and `holding` is undefined.
  // Null is the honest answer, never a fabricated zero-quantity position.
  const position =
    holding && live
      ? {
          currency: holding.currency,
          quantity: holding.quantity,
          avgCost: holding.avgCost,
          costBasisPLN: holding.costBasisPLN,
          unrealizedPLN: live.unrealizedPLN,
          unrealizedPct: live.unrealizedPct,
          direction: live.direction,
          valuePLN: live.valuePLN,
          oversold: holding.oversold,
        }
      : null;

  return {
    instrumentId,
    symbol,
    displayName,
    currency,
    exchange,
    owned: true,
    watched: await isWatched(userId, instrumentId),
    hasDividends: dividends,
    position,
    price: live?.price ?? null,
    // Only ever the fallback, never a second price: `composeSlice` fills it
    // exclusively when no live price rendered, and it is display-only.
    cachedPrice: live?.cachedPrice ?? null,
    dayPct: live?.dayPct ?? null,
    extended: live?.extended ?? null,
    // The session row the web page renders under the header. The currency
    // guard lives inside the helper, so a wrong-currency quote dashes out
    // here exactly as it does there.
    dayStats: dayStatsFigures(loaded.quotes.get(symbol), currency),
    about: composeAbout(
      aboutInputs.profile,
      loaded.quotes.get(symbol),
      currency,
      aboutInputs.bars,
    ),
    groups,
    transactions: txRows,
    priceTargets,
    // The raw usable quote (cached fallback under the same currency guard) —
    // the same base the watchlist tiles measure from.
    targetStatus: targetStatusFor(
      priceTargets,
      currentPriceFor(
        loaded.quotes.get(symbol),
        loaded.inputs.cachedQuotes?.get(symbol),
        currency,
      ),
      currency,
    ),
  };
}

/**
 * Everything the caller has no transactions for: watched, or merely looked at.
 *
 * The two used to be one branch and a 404. They are the same PAYLOAD — no
 * position, no groups, no rows, just identity plus the live figures, which is
 * exactly what the watched mode of the web page shows — and they differ in one
 * boolean, so they share the code that builds it. What changed is that failing
 * the watchlist check is no longer the end: a symbol the directory knows
 * resolves for browsing (`resolveInstrumentForBrowsing`), because you look at
 * a stock and THEN decide to follow it, and having to watch something to see
 * its price fills the watchlist with things nobody chose.
 *
 * A symbol nothing has ever heard of is still `null` here and a 404 at the
 * route. That is not the old ownership refusal — it is the honest answer to a
 * ticker that does not exist.
 *
 * Best-effort around the watchlist TABLE LOOKUP only, mirroring the page: a
 * not-yet-applied migration degrades to the browsing branch, never a throw.
 */
async function unownedDetail(
  userId: string,
  symbol: string,
): Promise<InstrumentDetail | null> {
  let watchedRow:
    | { instrumentId: string; displayName: string; exchange: string; currency: string }
    | undefined;
  try {
    [watchedRow] = await db
      .select({
        instrumentId: instruments.id,
        displayName: instruments.displayName,
        exchange: instruments.exchange,
        currency: instruments.currency,
      })
      .from(watchlist)
      .innerJoin(instruments, eq(watchlist.instrumentId, instruments.id))
      .where(and(eq(watchlist.userId, userId), eq(instruments.symbol, symbol)));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'watched lookup failed';
    console.error(`Watched lookup failed (${symbol}): ${message}`);
  }

  const isWatched = watchedRow !== undefined;
  const browsed = watchedRow ?? (await browsableIdentity(symbol));
  if (!browsed) return null;
  const watched = browsed;

  // The single ref opts this quote into the durable cache (write + the
  // transient-failure fallback read) — the narrow-loader discipline for a
  // one-symbol walk.
  const [{ quotes, cached }, aboutInputs, priceTargets] = await Promise.all([
    fetchQuotesBestEffort([symbol], new Map([[symbol, watched.instrumentId]])),
    (async () => {
      await syncInstrumentProfiles([watched.instrumentId]);
      return readAboutBundle({
        id: watched.instrumentId,
        symbol,
        currency: watched.currency,
      });
    })(),
    // Targets survive unwatching (a standing order until deleted), so even
    // the merely-browsed branch loads them rather than assuming none.
    listTargets(userId, watched.instrumentId),
  ]);

  // The same figure semantics as the Holdings tiles — currency guard, '—'
  // over fake zeros, extended passthrough.
  const figures = quoteFigures(quotes.get(symbol), watched.currency);

  // Cached fallback, the composeSlice rule verbatim: only when no live price
  // rendered, and only a currency-matching row — display-only, fetch-time
  // labelled on the client.
  const cachedEntry = figures.price === null ? cached.get(symbol) : undefined;
  const cachedPrice =
    cachedEntry !== undefined && cachedEntry.currency === watched.currency
      ? {
          text: fmtMoney(dec(cachedEntry.price), watched.currency),
          asOfMs: cachedEntry.fetchedAtMs,
        }
      : null;

  return {
    instrumentId: watched.instrumentId,
    symbol,
    displayName: watched.displayName,
    currency: watched.currency,
    exchange: watched.exchange,
    owned: false,
    watched: isWatched,
    // No transactions means no portfolio ever held it, so a dividend payment
    // is impossible rather than merely unfetched — true of a watched stock
    // and of one merely being looked at alike.
    hasDividends: false,
    position: null,
    price: figures.price,
    cachedPrice,
    dayPct: figures.dayPct,
    extended: figures.extended,
    dayStats: dayStatsFigures(quotes.get(symbol), watched.currency),
    about: composeAbout(
      aboutInputs.profile,
      quotes.get(symbol),
      watched.currency,
      aboutInputs.bars,
    ),
    groups: [],
    transactions: [],
    priceTargets,
    targetStatus: targetStatusFor(
      priceTargets,
      currentPriceFor(quotes.get(symbol), cached.get(symbol), watched.currency),
      watched.currency,
    ),
  };
}

/** Profile columns + 52-week bars, after the caller has synced the stamp. */
async function readAboutBundle(instrument: HistoryInstrument) {
  const window = week52Window(nyDateISOAt(Date.now()));
  const [row, bars] = await Promise.all([
    db
      .select({
        description: instruments.description,
        totalEmployees: instruments.totalEmployees,
        homepageUrl: instruments.homepageUrl,
        sharesOutstanding: instruments.sharesOutstanding,
      })
      .from(instruments)
      .where(eq(instruments.id, instrument.id))
      .limit(1)
      .then((rows) => rows[0]),
    getDailyBars(instrument, window),
  ]);
  return {
    profile: {
      description: row?.description ?? null,
      totalEmployees: row?.totalEmployees ?? null,
      homepageUrl: row?.homepageUrl ?? null,
      sharesOutstanding: row?.sharesOutstanding ?? null,
    },
    bars,
  };
}

/** Does this user watch an instrument they also hold? Owned and watched are
 *  not exclusive — the client shows a "watching" affordance either way. */
async function isWatched(userId: string, instrumentId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ instrumentId: watchlist.instrumentId })
      .from(watchlist)
      .where(and(eq(watchlist.userId, userId), eq(watchlist.instrumentId, instrumentId)))
      .limit(1);
    return row !== undefined;
  } catch (error) {
    // Same best-effort rule as the page's watched lookup: a store failure
    // hides the affordance, it never fails the whole payload.
    const message = error instanceof Error ? error.message : 'watch lookup failed';
    console.error(`Watch-flag lookup failed: ${message}`);
    return false;
  }
}

/**
 * Identity for a symbol the user has no relationship with, in this module's
 * own shape. Thin on purpose: the resolver is shared with the price series so
 * a browsed instrument charts from the same row it is priced from.
 */
async function browsableIdentity(symbol: string) {
  const instrument = await resolveInstrumentForBrowsing(symbol);
  if (!instrument) return undefined;
  return {
    instrumentId: instrument.id,
    displayName: instrument.displayName,
    exchange: instrument.exchange,
    currency: instrument.currency,
  };
}
