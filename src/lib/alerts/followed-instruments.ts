import 'server-only';

import { eq, sql } from 'drizzle-orm';

import { db, instruments, portfolios, transactions } from '@/lib/db';

export interface FollowedInstrument {
  id: string;
  symbol: string;
  /** The stored security name — `alertDisplayName` shortens it for the push title. */
  displayName: string;
  currency: string;
}

/**
 * Every instrument this user HOLDS, USD-only and deduped by id — the alert
 * set, deliberately narrower than the app's "followed" set elsewhere. Non-USD
 * instruments are filtered out before the first vendor call: Massive is
 * US-only, the same guard `loadIntradayCandles` applies in
 * `portfolio-series.ts`.
 *
 * "Holds" means a NET POSITIVE quantity in `transactions`, not "has ever
 * transacted": a position bought and then sold in full is not a holding, and
 * alerting on it would push about a stock the user deliberately exited.
 *
 * Two sources are EXCLUDED by decision (2026-08-21, user):
 *  - the WATCHLIST — a watched stock is a stock the user is only looking at,
 *    and option underlyings live there (`OptionsUnderlyingActions`' explicit
 *    tap), so including it made contract-driven symbols push like holdings;
 *  - OPTIONS themselves — `option_positions` is an island the alert cron never
 *    joins, so this is enforced simply by not reaching for it.
 * Widening this query back to the watchlist would silently re-enable both.
 */
export async function loadFollowedInstruments(userId: string): Promise<FollowedInstrument[]> {
  const held = await db
    .select({
      id: instruments.id,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      currency: instruments.currency,
    })
    .from(transactions)
    .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(eq(portfolios.userId, userId))
    .groupBy(instruments.id, instruments.symbol, instruments.displayName, instruments.currency)
    // Summed in Postgres `numeric`, never in JS — the quantity column is
    // numeric(20,8) and this comparison is money-adjacent math (CLAUDE.md §1).
    .having(
      sql`sum(case when ${transactions.side} = 'buy' then ${transactions.quantity} else -${transactions.quantity} end) > 0`,
    );

  const byId = new Map<string, FollowedInstrument>();
  for (const row of held) {
    if (row.currency !== 'USD') continue;
    byId.set(row.id, row);
  }
  return [...byId.values()];
}
