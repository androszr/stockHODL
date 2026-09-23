import 'server-only';

import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { invalidateAnalyticsMemo } from '@/lib/analytics/view';
import { invalidateDayReportMemo } from '@/lib/day-report/view';
import { db, instruments, portfolios, transactions } from '@/lib/db';
import { invalidatePortfolioSeriesMemo } from '@/lib/history/portfolio-series';
import { resolveOrCreateInstrument } from '@/lib/instruments/resolve';
import { dec, toNumeric } from '@/lib/money';
import type { TransactionInput } from '@/lib/validation';

/**
 * Transaction reads and writes, owned here rather than in the Server Action.
 *
 * Extracted for plan S1 so the phone and the web run the SAME write path —
 * including the instrument lock, the ownership scoping and the memo invalidation.
 * The ownership rule is unchanged and load-bearing: `instruments` is
 * deliberately global (single-user app), so ownership only ever flows through
 * `portfolios.userId`. Every statement below joins or filters on it.
 *
 * Input is an already-validated `TransactionInput` — the caller parses with
 * `transactionInputSchema`, which both the form and the mobile contract use.
 * Nothing here re-derives an FX rate or re-guesses a decimal separator.
 */

export type TransactionMutation =
  | { ok: true; id: string; portfolioId: string; symbol: string }
  | { ok: false; error: string };

export interface TransactionRow {
  id: string;
  portfolioId: string;
  portfolioName: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  currency: string;
  side: 'buy' | 'sell';
  quantity: string;
  price: string;
  fees: string;
  tradeDate: string;
  fxRateToBase: string;
  note: string | null;
}

/**
 * Drops this user's in-process memos after a transaction write, so the
 * portfolio series, analytics and day report do not keep stating pre-edit
 * figures. Best-effort on serverless (each memo lives per instance; another
 * instance keeps its copy until the 60 s TTL) — accepted staleness bound.
 */
function invalidateAfterTransactionChange(userId: string) {
  invalidatePortfolioSeriesMemo(userId);
  invalidateAnalyticsMemo(userId);
  invalidateDayReportMemo(userId);
}

/**
 * The user's transactions, newest trade first, optionally narrowed to one
 * portfolio or one symbol. Amounts come back as the stored `numeric` strings
 * — raw, not display text: an edit form needs the stored value, and the
 * client formats for itself.
 */
export async function listTransactions(
  userId: string,
  filter: { portfolioId?: string; symbol?: string } = {},
): Promise<TransactionRow[]> {
  const conditions = [eq(portfolios.userId, userId)];
  if (filter.portfolioId) conditions.push(eq(transactions.portfolioId, filter.portfolioId));
  if (filter.symbol) conditions.push(eq(instruments.symbol, filter.symbol));

  const rows = await db
    .select({
      id: transactions.id,
      portfolioId: transactions.portfolioId,
      portfolioName: portfolios.name,
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      exchange: instruments.exchange,
      currency: instruments.currency,
      side: transactions.side,
      quantity: transactions.quantity,
      price: transactions.price,
      fees: transactions.fees,
      tradeDate: transactions.tradeDate,
      fxRateToBase: transactions.fxRateToBase,
      note: transactions.note,
    })
    .from(transactions)
    .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(and(...conditions))
    .orderBy(desc(transactions.tradeDate), desc(transactions.createdAt));

  // `side` is a text column; the schema has no enum, so narrow at the edge
  // rather than asserting the whole row.
  return rows.map((r) => ({ ...r, side: r.side === 'sell' ? 'sell' : 'buy' }));
}

export async function createTransaction(
  userId: string,
  input: TransactionInput,
): Promise<TransactionMutation> {
  // Never trust the client-supplied portfolio id alone.
  const [portfolio] = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, input.portfolioId), eq(portfolios.userId, userId)));
  if (!portfolio) return { ok: false, error: 'Portfolio not found.' };

  // Resolve-or-create through the shared path: the do-nothing upsert +
  // currency-mismatch refusal shared with the watchlist add. Refusals
  // ("already exists as …", "Could not save …") surface verbatim.
  const instrument = await resolveOrCreateInstrument({
    symbol: input.symbol,
    displayName: input.displayName,
    exchange: input.exchange,
    currency: input.currency,
  });
  if (!instrument.ok) return { ok: false, error: instrument.error };

  // Overselling is deliberately not blocked here (a standing decision): manual
  // entry may arrive out of order. The position engine flags it instead.
  const [created] = await db
    .insert(transactions)
    .values({
      portfolioId: portfolio.id,
      instrumentId: instrument.id,
      side: input.side,
      quantity: toNumeric(dec(input.quantity)),
      price: toNumeric(dec(input.price)),
      fees: toNumeric(dec(input.fees)),
      tradeDate: input.tradeDate,
      fxRateToBase: toNumeric(dec(input.fxRateToBase), 10),
      note: input.note ?? null,
    })
    .returning({ id: transactions.id });

  invalidateAfterTransactionChange(userId);
  return {
    ok: true,
    id: created.id,
    portfolioId: portfolio.id,
    symbol: input.symbol,
  };
}

/**
 * Save-changes for one existing transaction.
 *
 * The instrument is LOCKED: the caller submits the stored symbol/currency
 * (the web form as hidden inputs, the phone from the row it loaded), and this
 * cross-checks them against the row — a mismatch is refused, and
 * `displayName`/`exchange` from the client are simply never written. No
 * instrument upsert, no `instrumentId` in the update set: changing the
 * instrument is a different trade, and the honest path is delete + re-add.
 *
 * The FX rate is likewise never re-derived here — exactly as in create, the
 * submitted field is the frozen truth.
 */
export async function updateTransaction(
  userId: string,
  id: string,
  input: TransactionInput,
): Promise<TransactionMutation> {
  // Load the existing row ownership-scoped: the join to portfolios on the
  // user id means a foreign or unknown id degrades to "not found" — the same
  // answer as a genuinely missing row, so nothing is enumerable.
  const [existing] = await db
    .select({
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      currency: instruments.currency,
    })
    .from(transactions)
    .innerJoin(
      portfolios,
      and(eq(transactions.portfolioId, portfolios.id), eq(portfolios.userId, userId)),
    )
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(eq(transactions.id, id));
  if (!existing) return { ok: false, error: 'Transaction not found.' };

  // The instrument lock. The identity fields normally round-trip untouched,
  // so hitting this means a hand-crafted request — refuse, never rebind.
  if (input.symbol !== existing.symbol || input.currency !== existing.currency) {
    return {
      ok: false,
      error: "The instrument can't be changed — delete this transaction and add a new one.",
    };
  }

  // The TARGET portfolio must be the user's own — moving a transaction to
  // another owned portfolio is a legitimate correction, anything else is not.
  const [portfolio] = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, input.portfolioId), eq(portfolios.userId, userId)));
  if (!portfolio) return { ok: false, error: 'Portfolio not found.' };

  // Ownership-scoped exactly like the delete; the empty-returning check
  // catches a row deleted between the load above and this write.
  const updated = await db
    .update(transactions)
    .set({
      portfolioId: portfolio.id,
      side: input.side,
      quantity: toNumeric(dec(input.quantity)),
      price: toNumeric(dec(input.price)),
      fees: toNumeric(dec(input.fees)),
      tradeDate: input.tradeDate,
      fxRateToBase: toNumeric(dec(input.fxRateToBase), 10),
      note: input.note ?? null,
    })
    .where(
      and(
        eq(transactions.id, id),
        inArray(
          transactions.portfolioId,
          db
            .select({ id: portfolios.id })
            .from(portfolios)
            .where(eq(portfolios.userId, userId)),
        ),
      ),
    )
    .returning({ id: transactions.id });
  if (updated.length === 0) return { ok: false, error: 'Transaction not found.' };

  invalidateAfterTransactionChange(userId);
  return {
    ok: true,
    id,
    portfolioId: portfolio.id,
    symbol: existing.symbol,
  };
}

/**
 * Ownership-scoped delete. A foreign or unknown id deletes nothing and is
 * reported as `deleted: false` — indistinguishable from a genuinely missing
 * row, so nothing is enumerable.
 *
 * The verdict is REPORTED, not acted on, because the two callers want
 * different things from it: the web action stays idempotent (it always
 * answered ok, and a row already gone is not worth an error toast on a screen
 * that is about to re-render without it), while the mobile handler turns
 * `false` into a 404 so a client working from a stale list learns its list is
 * stale. Deciding here would force one of them to be wrong.
 */
export async function deleteTransaction(
  userId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  const deleted = await db
    .delete(transactions)
    .where(
      and(
        eq(transactions.id, id),
        inArray(
          transactions.portfolioId,
          db
            .select({ id: portfolios.id })
            .from(portfolios)
            .where(eq(portfolios.userId, userId)),
        ),
      ),
    )
    .returning({ id: transactions.id });

  invalidateAfterTransactionChange(userId);
  return { deleted: deleted.length > 0 };
}

/**
 * The earliest trade date for one instrument in the user's own rows — the
 * chart anchor, and the ownership proof the price-series read needs. Null
 * when the user holds no transactions in it.
 */
export async function firstTradeDate(
  userId: string,
  instrumentId: string,
): Promise<{ symbol: string; currency: string; tradeDate: string } | null> {
  const [first] = await db
    .select({
      symbol: instruments.symbol,
      currency: instruments.currency,
      tradeDate: transactions.tradeDate,
    })
    .from(transactions)
    .innerJoin(
      portfolios,
      and(eq(transactions.portfolioId, portfolios.id), eq(portfolios.userId, userId)),
    )
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(eq(transactions.instrumentId, instrumentId))
    .orderBy(asc(transactions.tradeDate))
    .limit(1);

  return first ?? null;
}
