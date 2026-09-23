import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import { db, instruments, portfolios, transactions } from '@/lib/db';
import {
  createManualPayment,
  deletePayment,
  updatePayment,
} from '@/lib/dividends/store';
import { syncDividends } from '@/lib/dividends/sync';
import type {
  DividendCreateInput,
  DividendUpdateInput,
} from '@/lib/dividends/validation';

/**
 * Dividend writes, owned here rather than in the Server Action — the
 * `src/lib/portfolios/mutations.ts` extraction repeated for the same reason:
 * the phone and the web must run the SAME code, not two implementations of
 * one tax record.
 *
 * Every function takes the user id first and scopes every statement by
 * `portfolios.userId`; nothing here reads a session, which is exactly what
 * lets both a Server Action and a route handler call it. The table itself is
 * still owned by `src/lib/dividends/store.ts` — this module resolves
 * ownership and hands the store an input it has already vouched for.
 */

export type DividendMutation = { ok: true } | { ok: false; error: string };

/** One instrument the user may attach a manual payment to. */
export interface TransactedInstrument {
  id: string;
  symbol: string;
  displayName: string;
  currency: string;
}

/**
 * The user's own TRANSACTED instruments — the manual form's only choices.
 * A dividend attaches to a stock the ledger already knows about; the entry
 * path can never mint an instrument, on either client.
 */
export async function listTransactedInstruments(
  userId: string,
): Promise<TransactedInstrument[]> {
  return db
    .selectDistinct({
      id: instruments.id,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      currency: instruments.currency,
    })
    .from(transactions)
    .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(eq(portfolios.userId, userId))
    .orderBy(asc(instruments.symbol));
}

/** Is this portfolio the caller's own? Never trust the submitted id alone. */
async function ownedPortfolio(userId: string, portfolioId: string) {
  const [row] = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)));
  return row;
}

/** The instrument must be one the user has actually traded — ownership flows
 *  through portfolios, and a form or JSON value can never mint one here. */
async function transactedInstrument(userId: string, instrumentId: string) {
  const [row] = await db
    .select({ id: instruments.id })
    .from(transactions)
    .innerJoin(
      portfolios,
      and(eq(transactions.portfolioId, portfolios.id), eq(portfolios.userId, userId)),
    )
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(eq(instruments.id, instrumentId))
    .limit(1);
  return row;
}

/**
 * Re-ask the vendor now — the Refresh control on both clients and the
 * first-visit fill. `syncDividends` is best-effort end to end and never
 * throws; edited and manual rows survive by the store's one rule.
 */
export async function refreshDividendsFor(userId: string): Promise<DividendMutation> {
  await syncDividends(userId);
  return { ok: true };
}

export async function createDividendFor(
  userId: string,
  input: DividendCreateInput,
): Promise<DividendMutation> {
  const portfolio = await ownedPortfolio(userId, input.portfolioId);
  if (!portfolio) return { ok: false, error: 'Portfolio not found.' };

  const instrument = await transactedInstrument(userId, input.instrumentId);
  if (!instrument) return { ok: false, error: 'Instrument not found.' };

  const created = await createManualPayment(userId, {
    portfolioId: portfolio.id,
    instrumentId: instrument.id,
    exDate: input.exDate,
    payDate: input.payDate ?? null,
    quantity: input.quantity,
    amountPerShare: input.amountPerShare,
    grossAmount: input.grossAmount,
    withheldTax: input.withheldTax,
    currency: input.currency,
    fxRateToBase: input.fxRateToBase ?? null,
    note: input.note ?? null,
  });
  if (!created) return { ok: false, error: 'Portfolio not found.' };

  return { ok: true };
}

/**
 * The refusal a vendor-sourced row gets when it is asked to change portfolio.
 * Stated once so both clients show the user the same sentence.
 */
export const PORTFOLIO_LOCKED_MESSAGE =
  "A fetched payment can't move to another portfolio — the next refresh " +
  'would re-create it in the old one. Delete it and add a manual payment instead.';

export async function updateDividendFor(
  userId: string,
  id: string,
  input: DividendUpdateInput,
): Promise<DividendMutation> {
  // The TARGET portfolio must be the user's own — moving a MANUAL payment
  // between owned portfolios is a legitimate correction, anything else is
  // not. The store additionally locks the portfolio of vendor-sourced rows.
  const portfolio = await ownedPortfolio(userId, input.portfolioId);
  if (!portfolio) return { ok: false, error: 'Portfolio not found.' };

  // The store sets `edited = true` — from here the refresh never touches it.
  const updated = await updatePayment(userId, id, {
    portfolioId: portfolio.id,
    exDate: input.exDate,
    payDate: input.payDate ?? null,
    quantity: input.quantity,
    amountPerShare: input.amountPerShare,
    grossAmount: input.grossAmount,
    withheldTax: input.withheldTax,
    fxRateToBase: input.fxRateToBase ?? null,
    note: input.note ?? null,
  });
  if (updated === 'portfolio_locked') {
    return { ok: false, error: PORTFOLIO_LOCKED_MESSAGE };
  }
  if (updated !== 'updated') return { ok: false, error: 'Payment not found.' };

  return { ok: true };
}

export async function deleteDividendFor(
  userId: string,
  id: string,
): Promise<DividendMutation> {
  const deleted = await deletePayment(userId, id);
  if (!deleted) return { ok: false, error: 'Payment not found.' };

  return { ok: true };
}
