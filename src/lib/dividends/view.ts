import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db, instruments, portfolios, transactions } from '@/lib/db';
import {
  listDividendPayments,
  type DividendPaymentRow,
} from '@/lib/dividends/store';
import { dividendsSyncFresh, syncDividends } from '@/lib/dividends/sync';
import { resolvePortfolioScope } from '@/lib/holdings/scope';

/**
 * The rows behind a dividends screen, for whichever surface is asking.
 *
 * Extracted from `(app)/dividends/page.tsx` when the phone got the screen
 * (2026-08-18). What matters is that the SYNC-ON-EMPTY lives in here: a first
 * visit with no rows runs one awaited best-effort sync, and that is the only
 * thing that fills the history — there is no cron. Had the mobile route
 * skipped it, the phone would have shown a permanently empty Dividends tab
 * on a fresh install while the browser filled itself on first load, and the
 * two surfaces would have disagreed about whether the user has ever been
 * paid a dividend.
 *
 * The FOLD is not here: `summarizeDividends`/`groupPaymentsByYear` are pure
 * and each surface calls them on these rows. One fold, and the reason it is
 * one fold is that per-portfolio figures must sum to the combined view by
 * construction rather than by coincidence.
 */

export interface DividendsView {
  rows: DividendPaymentRow[];
  /** The resolved portfolio scope, or null for All. Ownership already proved. */
  portfolioId: string | null;
  /** Set only when `symbol` named an instrument the user actually traded. */
  symbolFilter: { id: string; symbol: string } | null;
}

/**
 * `portfolioIdParam` goes through the ONE scope resolver — a malformed or
 * foreign id silently becomes All, never an error and never a leak.
 *
 * `symbol` is validated against the user's OWN transacted set rather than the
 * instruments table: an arbitrary or foreign symbol degrades to the
 * unfiltered view, so this parameter can neither enumerate instruments nor
 * behave differently for "exists but not yours" than for "does not exist".
 */
export async function loadDividendsView(
  userId: string,
  params: { portfolioIdParam?: string | string[] | undefined; symbol?: string | undefined } = {},
): Promise<DividendsView> {
  const portfolioId = await resolvePortfolioScope(userId, params.portfolioIdParam);

  let symbolFilter: { id: string; symbol: string } | null = null;
  const rawSymbol = params.symbol;
  if (typeof rawSymbol === 'string' && rawSymbol.length > 0 && rawSymbol.length <= 20) {
    const [owned] = await db
      .select({ id: instruments.id, symbol: instruments.symbol })
      .from(transactions)
      .innerJoin(
        portfolios,
        and(eq(transactions.portfolioId, portfolios.id), eq(portfolios.userId, userId)),
      )
      .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
      .where(eq(instruments.symbol, rawSymbol.toUpperCase()))
      .limit(1);
    if (owned) symbolFilter = owned;
  }

  const filter = {
    ...(portfolioId !== null ? { portfolioId } : {}),
    ...(symbolFilter !== null ? { instrumentId: symbolFilter.id } : {}),
  };

  let rows = await listDividendPayments(userId, filter);

  // First visit: ONE awaited best-effort sync per instance-freshness window.
  // `syncDividends` never throws — a vendor outage degrades to the empty
  // state, never to a broken screen.
  if (rows.length === 0 && !dividendsSyncFresh()) {
    await syncDividends(userId);
    rows = await listDividendPayments(userId, filter);
  }

  return { rows, portfolioId, symbolFilter };
}

/**
 * "Today" for the YTD boundary, pinned to Warsaw rather than the server's
 * clock: the ledger's year is the user's year, and a UTC server would move
 * the boundary for two hours every New Year's Eve.
 */
export function warsawTodayISO(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now);
}
