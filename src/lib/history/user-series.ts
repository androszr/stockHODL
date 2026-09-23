import 'server-only';

import { and, eq } from 'drizzle-orm';

import type { ChartRange } from '@/lib/charts/ranges';
import { emptySeries, type SeriesPayload } from '@/lib/charts/series';
import { db, instruments, watchlist } from '@/lib/db';
import { instrumentAnchorDate } from '@/lib/history/anchor';
import {
  getInstrumentPriceSeries,
  getPortfolioValueSeries,
} from '@/lib/history/portfolio-series';
import { resolvePortfolioScope } from '@/lib/holdings/scope';
import { nyDateISOAt } from '@/lib/market-data/market-clock';
import { resolveInstrumentForBrowsing } from '@/lib/instruments/resolve';
import { firstTradeDate } from '@/lib/transactions/mutations';
import { watchedAnchorDate } from '@/lib/watchlist/anchor';

/**
 * Chart series scoped to one user — the shared body of the chart Server
 * Actions, extracted for plan S1 so the mobile routes run the identical
 * ownership and refusal logic.
 *
 * ONE rule throughout: every refusal — foreign instrument, unknown symbol,
 * deleted portfolio — degrades to the same honest empty payload. Never a 404
 * for a series, never an error, so nothing about what exists is enumerable.
 * The range is already parsed by the caller and never reaches a query or a
 * vendor URL as a raw string.
 */

/**
 * Portfolio value in PLN over one range, optionally scoped to one portfolio.
 * The scope goes through the SAME resolver the page uses: a foreign,
 * malformed or deleted id silently becomes the all-portfolios series, and the
 * underlying query re-scopes by `userId` besides.
 */
export async function userPortfolioSeries(
  userId: string,
  range: ChartRange,
  portfolioId?: string,
): Promise<SeriesPayload> {
  const scope = await resolvePortfolioScope(userId, portfolioId);
  return getPortfolioValueSeries(userId, range, scope ?? undefined);
}

/**
 * Price series for ONE instrument the user holds transactions in — or, since
 * the watchlist, one the user watches: the transactions join is checked first,
 * then the user's own watchlist rows. Both branches anchor the SAME way since
 * 2026-08-20 (`instrumentAnchorDate`): a price chart is about the instrument,
 * not the position, so a stock bought on Monday charts the same window as the
 * identical stock merely watched.
 */
export async function userPriceSeries(
  userId: string,
  instrumentId: string,
  range: ChartRange,
): Promise<SeriesPayload> {
  // Ownership check: the instrument must appear in the user's own
  // transactions (ownership flows through portfolios, as everywhere else).
  const owned = await firstTradeDate(userId, instrumentId);
  if (owned) {
    return getInstrumentPriceSeries(
      { id: instrumentId, symbol: owned.symbol, currency: owned.currency },
      instrumentAnchorDate(nyDateISOAt(Date.now()), owned.tradeDate),
      range,
    );
  }

  return watchedSeriesOrEmpty(userId, instrumentId, range);
}

/**
 * The same series addressed by SYMBOL — what the native instrument screen
 * holds, and now the BROWSING path: any symbol the directory knows charts,
 * whether or not the caller owns or watches it. A ticker nothing has heard of
 * still produces the empty payload, and still produces it for the same reason
 * a foreign uuid does — never a 404, which would let a caller distinguish "no
 * data" from "not yours" one request at a time.
 *
 * The by-uuid `userPriceSeries` above keeps its ownership gate untouched: a
 * uuid is not a thing a person browses, and widening it would widen an
 * address space nothing needs widened.
 */
export async function userPriceSeriesBySymbol(
  userId: string,
  symbol: string,
  range: ChartRange,
): Promise<SeriesPayload> {
  // The SAME resolver the detail payload uses, so a browsed instrument charts
  // from the row it is priced from — a second lookup here could mint a
  // different one and give the screen a chart for an instrument its header is
  // not about.
  const instrument = await resolveInstrumentForBrowsing(symbol);
  if (!instrument) return emptySeries();

  // A position anchors the window to the first trade; everything else — a
  // watched stock, one merely being looked at — takes the fixed 5-year
  // policy. That split is about the DATA available, not about permission:
  // charting is no longer gated on a relationship with the symbol, because a
  // price chart is a fact about the instrument.
  const owned = await firstTradeDate(userId, instrument.id);
  const anchor = owned
    ? instrumentAnchorDate(nyDateISOAt(Date.now()), owned.tradeDate)
    : watchedAnchorDate(nyDateISOAt(Date.now()));

  return getInstrumentPriceSeries(
    { id: instrument.id, symbol: instrument.symbol, currency: instrument.currency },
    anchor,
    range,
  );
}

/**
 * The watchlist fallback: same ownership discipline (the row must be the
 * session user's own), same refusal shape on a miss. Best-effort around the
 * TABLE LOOKUP ONLY — a not-yet-applied migration degrades to the refusal,
 * never a throw. The series fetch stays OUTSIDE that guard so this path
 * cannot turn a series failure into something the owned path would report
 * differently.
 */
async function watchedSeriesOrEmpty(
  userId: string,
  instrumentId: string,
  range: ChartRange,
): Promise<SeriesPayload> {
  let watched: { id: string; symbol: string; currency: string } | undefined;
  try {
    [watched] = await db
      .select({
        id: instruments.id,
        symbol: instruments.symbol,
        currency: instruments.currency,
      })
      .from(watchlist)
      .innerJoin(instruments, eq(watchlist.instrumentId, instruments.id))
      .where(and(eq(watchlist.userId, userId), eq(watchlist.instrumentId, instrumentId)));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'watched series failed';
    console.error(`Watched series lookup failed: ${message}`);
    return emptySeries();
  }
  if (!watched) return emptySeries();

  // No first trade to anchor on — the fixed 5-year watched policy.
  return getInstrumentPriceSeries(watched, watchedAnchorDate(nyDateISOAt(Date.now())), range);
}
