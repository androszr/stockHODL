import 'server-only';

import { and, asc, count, eq, max } from 'drizzle-orm';

import { db, portfolios, transactions } from '@/lib/db';
import { isUniqueViolation } from '@/lib/db-errors';

/**
 * Portfolio reads and writes, owned here rather than in the Server Action.
 *
 * The extraction (plan S1) exists so the phone and the web run the SAME code:
 * every function takes the user id as its first argument, and every statement
 * is scoped by `portfolios.userId` — never by a client-supplied id alone. The
 * caller is responsible for establishing the user id from a session; nothing
 * in this module reads a session, which is exactly why both callers can use
 * it.
 */

export type PortfolioMutation = { ok: true; id?: string } | { ok: false; error: string };

export interface PortfolioRow {
  id: string;
  name: string;
  sortOrder: number;
  txCount: number;
}

/**
 * The user's portfolios in display order, with their transaction counts —
 * the chip row's raw material, empty portfolios included (they still deserve
 * a chip). The count comes from a LEFT JOIN aggregate rather than a query per
 * portfolio: the same "ask the database once" discipline the prior-close read
 * follows.
 */
export async function listPortfolios(userId: string): Promise<PortfolioRow[]> {
  const rows = await db
    .select({
      id: portfolios.id,
      name: portfolios.name,
      sortOrder: portfolios.sortOrder,
      txCount: count(transactions.id),
    })
    .from(portfolios)
    .leftJoin(transactions, eq(transactions.portfolioId, portfolios.id))
    .where(eq(portfolios.userId, userId))
    .groupBy(portfolios.id, portfolios.name, portfolios.sortOrder, portfolios.createdAt)
    .orderBy(asc(portfolios.sortOrder), asc(portfolios.createdAt), asc(portfolios.name));

  return rows;
}

export async function createPortfolio(
  userId: string,
  name: string,
): Promise<PortfolioMutation> {
  const [{ value: maxOrder }] = await db
    .select({ value: max(portfolios.sortOrder) })
    .from(portfolios)
    .where(eq(portfolios.userId, userId));

  let created: { id: string } | undefined;
  try {
    [created] = await db
      .insert(portfolios)
      .values({ userId, name, sortOrder: (maxOrder ?? -1) + 1 })
      // returning() so the caller can select the new portfolio as the
      // Holdings scope — matching it back by name would pick the wrong row
      // the moment two portfolios ever shared one.
      .returning({ id: portfolios.id });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { ok: false, error: `A portfolio named “${name}” already exists.` };
    }
    throw e;
  }

  return { ok: true, id: created?.id };
}

export async function renamePortfolio(
  userId: string,
  id: string,
  name: string,
): Promise<PortfolioMutation> {
  try {
    // returning() so a stale id (row deleted in another tab, replayed id)
    // reports "not found" instead of a phantom success that closes the editor.
    const updated = await db
      .update(portfolios)
      .set({ name })
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, userId)))
      .returning({ id: portfolios.id });
    if (updated.length === 0) return { ok: false, error: 'Portfolio not found.' };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { ok: false, error: `A portfolio named “${name}” already exists.` };
    }
    throw e;
  }

  return { ok: true };
}

/**
 * Absolute reorder: the caller sends the full id list in the order the user
 * dropped them into, and every row's sortOrder is rewritten to its index. The
 * list must be exactly the user's current set — a partial or stale list would
 * leave holes and ties in sortOrder, so it is rejected rather than patched.
 */
export async function reorderPortfolios(
  userId: string,
  ids: readonly string[],
): Promise<PortfolioMutation> {
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'Invalid request.' };

  const rows = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(eq(portfolios.userId, userId));

  const owned = new Set(rows.map((r) => r.id));
  if (ids.length !== rows.length || ids.some((id) => !owned.has(id))) {
    return { ok: false, error: 'Portfolio list changed — reload and try again.' };
  }

  const updates = ids.map((id, index) =>
    db
      .update(portfolios)
      .set({ sortOrder: index })
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, userId))),
  );

  // Neon HTTP has no interactive transactions; batch keeps the rewrite atomic.
  // The array is non-empty (the callers' schemas enforce min(1)), which
  // db.batch's tuple type cannot infer on its own.
  await db.batch(updates as [(typeof updates)[number], ...typeof updates]);

  return { ok: true };
}

export async function deletePortfolio(
  userId: string,
  id: string,
): Promise<PortfolioMutation> {
  // Destructive by design: the FK cascade removes this portfolio's
  // transactions. The confirmation (with the row count) lives in the UI.
  const deleted = await db
    .delete(portfolios)
    .where(and(eq(portfolios.id, id), eq(portfolios.userId, userId)))
    .returning({ id: portfolios.id });
  if (deleted.length === 0) return { ok: false, error: 'Portfolio not found.' };

  return { ok: true };
}
