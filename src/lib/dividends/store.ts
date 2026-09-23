import 'server-only';

import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import { db, dividendPayments, instruments, portfolios } from '@/lib/db';
import { dec, toNumeric } from '@/lib/money';

/**
 * The `server-only` owner of `dividend_payments` — the ONLY module that reads
 * or writes the table (the `calendar-store.ts` convention). Server Actions
 * and the sync both go through here; a second call site touching the table is
 * how the overwrite-protection rule eventually gets forgotten.
 *
 * THE TAX-RECORD GUARANTEE, enforced in exactly one place
 * ({@link planFetchedWrite} + the matching SQL guard in
 * {@link upsertFetchedPayments}): an automatic refresh may only ever touch a
 * row it created itself and that no human has corrected — `source =
 * 'massive' AND edited = false`. An `edited` or `manual` row is NEVER
 * written by a refresh; the user's correction always wins. The asymmetry is
 * deliberate: unedited fetched rows SELF-HEAL on the next sync after a
 * backdated transaction edit (recomputed quantity/gross flow through), while
 * edited and manual rows stay frozen — this is a record the user may file
 * taxes from.
 *
 * DELETION WINS THE SAME WAY (2026-08-16 fix): removing a vendor-sourced row
 * TOMBSTONES it (`deleted = true`) rather than vacating its
 * `(vendorEventId, portfolioId)` key — the ledger still derives qty > 0 for
 * that ex-date, so a hard delete would be silently re-inserted by the next
 * sync. {@link planFetchedWrite} treats a tombstone as skip, and
 * {@link listDividendPayments} never surfaces one. Manual rows (null vendor
 * id) hard-delete: nothing can re-create them.
 *
 * And the PORTFOLIO of a vendor-sourced row is LOCKED (like its instrument
 * and currency): the payment derives from ONE portfolio's ledger, so
 * re-keying it to another portfolio would vacate the old key for the next
 * sync to re-fill — the same dividend then counts twice. Moving a fetched
 * payment is delete (tombstone) + manual re-add. Manual rows move freely.
 *
 * Ownership flows through `portfolios.userId` in SQL on every read and every
 * mutation — never a bare id trusted from a caller. Money in and out as
 * decimal strings via `dec()`/`toNumeric`; a JS number never carries an
 * amount here.
 */

/** One payment row joined with its portfolio and instrument labels. */
export interface DividendPaymentRow {
  id: string;
  portfolioId: string;
  portfolioName: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  vendorEventId: string | null;
  exDate: string;
  payDate: string | null;
  quantity: string;
  amountPerShare: string;
  grossAmount: string;
  withheldTax: string;
  currency: string;
  /** Frozen D-1 NBP rate at `payDate ?? exDate`; null until published. */
  fxRateToBase: string | null;
  source: 'massive' | 'manual';
  edited: boolean;
  note: string | null;
}

export interface ListFilter {
  portfolioId?: string;
  instrumentId?: string;
}

/** Every payment the user owns, newest ex-date first, optionally filtered. */
export async function listDividendPayments(
  userId: string,
  filter: ListFilter = {},
): Promise<DividendPaymentRow[]> {
  // Tombstoned rows are deleted as far as every caller is concerned — the
  // store is the only module that knows they still exist.
  const conditions = [eq(portfolios.userId, userId), eq(dividendPayments.deleted, false)];
  if (filter.portfolioId !== undefined) {
    conditions.push(eq(dividendPayments.portfolioId, filter.portfolioId));
  }
  if (filter.instrumentId !== undefined) {
    conditions.push(eq(dividendPayments.instrumentId, filter.instrumentId));
  }

  const rows = await db
    .select({
      id: dividendPayments.id,
      portfolioId: dividendPayments.portfolioId,
      portfolioName: portfolios.name,
      instrumentId: dividendPayments.instrumentId,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      vendorEventId: dividendPayments.vendorEventId,
      exDate: dividendPayments.exDate,
      payDate: dividendPayments.payDate,
      quantity: dividendPayments.quantity,
      amountPerShare: dividendPayments.amountPerShare,
      grossAmount: dividendPayments.grossAmount,
      withheldTax: dividendPayments.withheldTax,
      currency: dividendPayments.currency,
      fxRateToBase: dividendPayments.fxRateToBase,
      source: dividendPayments.source,
      edited: dividendPayments.edited,
      note: dividendPayments.note,
    })
    .from(dividendPayments)
    .innerJoin(portfolios, eq(dividendPayments.portfolioId, portfolios.id))
    .innerJoin(instruments, eq(dividendPayments.instrumentId, instruments.id))
    .where(and(...conditions))
    .orderBy(desc(dividendPayments.exDate), desc(dividendPayments.createdAt));

  // `source` is checked, never cast wholesale — the column type is text.
  return rows.map((r) => ({ ...r, source: r.source === 'manual' ? 'manual' : 'massive' }));
}

/**
 * Does the user own ANY (non-tombstoned) payment for this instrument? The
 * instrument screen's cheap existence check — a boolean, never the rows
 * themselves, so an instrument with no dividend history costs one indexed
 * lookup rather than the full list read.
 */
export async function hasDividendPayments(userId: string, instrumentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: dividendPayments.id })
    .from(dividendPayments)
    .innerJoin(portfolios, eq(dividendPayments.portfolioId, portfolios.id))
    .where(
      and(
        eq(portfolios.userId, userId),
        eq(dividendPayments.instrumentId, instrumentId),
        eq(dividendPayments.deleted, false),
      ),
    );
  return rows.length > 0;
}

/** One fetched (vendor-derived) payment, as the sync computes it. */
export interface FetchedPaymentInput {
  portfolioId: string;
  instrumentId: string;
  vendorEventId: string;
  exDate: string;
  payDate: string | null;
  /** Decimal strings throughout — never JS numbers. */
  quantity: string;
  amountPerShare: string;
  grossAmount: string;
  withheldTax: string;
  currency: string;
  fxRateToBase: string | null;
}

/** What already exists for a `(vendorEventId, portfolioId)` pair. */
export interface ExistingPaymentFlags {
  source: string;
  edited: boolean;
  deleted: boolean;
}

/**
 * THE overwrite-protection rule — the single decision point every fetched
 * write goes through. Absent → insert; a tombstone → skip (the user deleted
 * it, and a deletion must win over a refetch exactly like an edit does — the
 * key stays occupied precisely so this branch fires); a row the refresh
 * created itself and nobody edited → update (self-heal); anything a human
 * touched (`edited`) or created (`manual`) → skip, unconditionally.
 */
export function planFetchedWrite(
  existing: ExistingPaymentFlags | undefined,
): 'insert' | 'update' | 'skip' {
  if (existing === undefined) return 'insert';
  if (existing.deleted) return 'skip';
  if (existing.source === 'massive' && !existing.edited) return 'update';
  return 'skip';
}

/**
 * Write-through for the sync: insert new `(vendorEventId, portfolioId)`
 * pairs, refresh rows that {@link planFetchedWrite} allows (recomputed
 * quantity/gross/withheld-at-default and a late-published `fxRateToBase`),
 * and leave everything else untouched. The UPDATE's WHERE clause re-asserts
 * `source = 'massive' AND edited = false` in SQL, so a user edit racing the
 * sync between read and write still cannot be overwritten — the same one
 * rule, made transactional rather than duplicated.
 */
export async function upsertFetchedPayments(rows: readonly FetchedPaymentInput[]): Promise<void> {
  if (rows.length === 0) return;

  const vendorIds = [...new Set(rows.map((r) => r.vendorEventId))];
  const existingRows = await db
    .select({
      id: dividendPayments.id,
      vendorEventId: dividendPayments.vendorEventId,
      portfolioId: dividendPayments.portfolioId,
      source: dividendPayments.source,
      edited: dividendPayments.edited,
      deleted: dividendPayments.deleted,
    })
    .from(dividendPayments)
    .where(inArray(dividendPayments.vendorEventId, vendorIds));

  const byKey = new Map(existingRows.map((r) => [`${r.vendorEventId}|${r.portfolioId}`, r]));

  const inserts: FetchedPaymentInput[] = [];
  for (const row of rows) {
    const existing = byKey.get(`${row.vendorEventId}|${row.portfolioId}`);
    const plan = planFetchedWrite(existing);
    if (plan === 'skip') continue;
    if (plan === 'insert') {
      inserts.push(row);
      continue;
    }
    // plan === 'update' — existing is defined by construction.
    await db
      .update(dividendPayments)
      .set({
        exDate: row.exDate,
        payDate: row.payDate,
        quantity: toNumeric(dec(row.quantity)),
        amountPerShare: toNumeric(dec(row.amountPerShare)),
        grossAmount: toNumeric(dec(row.grossAmount)),
        withheldTax: toNumeric(dec(row.withheldTax)),
        currency: row.currency,
        // An incoming null rate means "the FX lookup had NO ANSWER this run"
        // (NBP outage, not-yet-published), never "there is no rate" — so the
        // column is SKIPPED, not written: automation must never degrade a
        // stored frozen rate to absence. A late-published rate (non-null)
        // still flows through; only the insert path may write null (a new
        // row honestly has no rate yet).
        ...(row.fxRateToBase === null
          ? {}
          : { fxRateToBase: toNumeric(dec(row.fxRateToBase), 10) }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dividendPayments.id, existing!.id),
          // The protection rule, re-asserted transactionally (see the doc).
          eq(dividendPayments.source, 'massive'),
          eq(dividendPayments.edited, false),
          eq(dividendPayments.deleted, false),
        ),
      );
  }

  if (inserts.length > 0) {
    await db
      .insert(dividendPayments)
      .values(
        inserts.map((row) => ({
          portfolioId: row.portfolioId,
          instrumentId: row.instrumentId,
          vendorEventId: row.vendorEventId,
          exDate: row.exDate,
          payDate: row.payDate,
          quantity: toNumeric(dec(row.quantity)),
          amountPerShare: toNumeric(dec(row.amountPerShare)),
          grossAmount: toNumeric(dec(row.grossAmount)),
          withheldTax: toNumeric(dec(row.withheldTax)),
          currency: row.currency,
          fxRateToBase: row.fxRateToBase === null ? null : toNumeric(dec(row.fxRateToBase), 10),
          source: 'massive',
          edited: false,
        })),
      )
      // Race-safe against a concurrent sync: the unique key decides, and a
      // second writer's duplicate insert is simply dropped.
      .onConflictDoNothing({
        target: [dividendPayments.vendorEventId, dividendPayments.portfolioId],
      });
  }
}

/** A hand-entered payment (`source = 'manual'`, no vendor id — exempt from
 *  the vendor dedupe by construction). */
export interface ManualPaymentInput {
  portfolioId: string;
  instrumentId: string;
  exDate: string;
  payDate: string | null;
  quantity: string;
  amountPerShare: string;
  grossAmount: string;
  withheldTax: string;
  currency: string;
  fxRateToBase: string | null;
  note: string | null;
}

/** Insert a manual payment; false when the portfolio is not the user's. */
export async function createManualPayment(
  userId: string,
  input: ManualPaymentInput,
): Promise<boolean> {
  // Ownership in SQL — never trust the caller-supplied portfolio id alone.
  const [portfolio] = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, input.portfolioId), eq(portfolios.userId, userId)));
  if (!portfolio) return false;

  await db.insert(dividendPayments).values({
    portfolioId: portfolio.id,
    instrumentId: input.instrumentId,
    vendorEventId: null,
    exDate: input.exDate,
    payDate: input.payDate,
    quantity: toNumeric(dec(input.quantity)),
    amountPerShare: toNumeric(dec(input.amountPerShare)),
    grossAmount: toNumeric(dec(input.grossAmount)),
    withheldTax: toNumeric(dec(input.withheldTax)),
    currency: input.currency,
    fxRateToBase: input.fxRateToBase === null ? null : toNumeric(dec(input.fxRateToBase), 10),
    source: 'manual',
    edited: false,
  });
  return true;
}

/** Every stored figure a correction may change. Instrument and currency are
 *  locked (the transaction-edit precedent): a different company or currency
 *  is a different payment — delete and re-add. The PORTFOLIO is additionally
 *  locked on vendor-sourced rows (see the module doc): `portfolioId` here is
 *  only ever a move for manual rows. */
export interface PaymentUpdateInput {
  portfolioId: string;
  exDate: string;
  payDate: string | null;
  quantity: string;
  amountPerShare: string;
  grossAmount: string;
  withheldTax: string;
  fxRateToBase: string | null;
  note: string | null;
}

export type UpdatePaymentResult = 'updated' | 'not_found' | 'portfolio_locked';

/**
 * Save a correction. Sets `edited = true` — from this moment the refresh can
 * never touch the row again. `'not_found'` when the payment (or the target
 * portfolio) is not the user's; `'portfolio_locked'` when the caller tried
 * to move a VENDOR-sourced row to another portfolio — that would vacate its
 * `(vendorEventId, portfolioId)` key for the next sync to re-fill (the same
 * dividend counting twice), and re-keying could collide with
 * `uq_dividend_vendor_portfolio` besides. With the lock, no path through
 * this function can violate that constraint: vendor rows never change key,
 * and manual rows carry a NULL vendor id the constraint exempts — so there
 * is deliberately no unique-violation catch here; the case is unreachable
 * by construction, not silently swallowed.
 */
export async function updatePayment(
  userId: string,
  id: string,
  input: PaymentUpdateInput,
): Promise<UpdatePaymentResult> {
  // The TARGET portfolio must be the user's own — moving a MANUAL payment
  // between owned portfolios is a legitimate correction, anything else is not.
  const [portfolio] = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, input.portfolioId), eq(portfolios.userId, userId)));
  if (!portfolio) return 'not_found';

  // The row itself, ownership-scoped, tombstones excluded — needed to decide
  // whether the portfolio field is a (forbidden) move of a vendor row.
  const [current] = await db
    .select({
      id: dividendPayments.id,
      portfolioId: dividendPayments.portfolioId,
      vendorEventId: dividendPayments.vendorEventId,
    })
    .from(dividendPayments)
    .innerJoin(portfolios, eq(dividendPayments.portfolioId, portfolios.id))
    .where(
      and(
        eq(dividendPayments.id, id),
        eq(portfolios.userId, userId),
        eq(dividendPayments.deleted, false),
      ),
    );
  if (!current) return 'not_found';
  if (current.vendorEventId !== null && current.portfolioId !== portfolio.id) {
    return 'portfolio_locked';
  }

  const updated = await db
    .update(dividendPayments)
    .set({
      portfolioId: portfolio.id,
      exDate: input.exDate,
      payDate: input.payDate,
      quantity: toNumeric(dec(input.quantity)),
      amountPerShare: toNumeric(dec(input.amountPerShare)),
      grossAmount: toNumeric(dec(input.grossAmount)),
      withheldTax: toNumeric(dec(input.withheldTax)),
      fxRateToBase: input.fxRateToBase === null ? null : toNumeric(dec(input.fxRateToBase), 10),
      note: input.note,
      edited: true,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dividendPayments.id, id),
        // Ownership and the tombstone re-asserted in the write itself, so a
        // concurrent delete between the read above and this UPDATE cannot
        // resurrect a tombstoned row.
        eq(dividendPayments.deleted, false),
        inArray(
          dividendPayments.portfolioId,
          db.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.userId, userId)),
        ),
      ),
    )
    .returning({ id: dividendPayments.id });
  return updated.length > 0 ? 'updated' : 'not_found';
}

/**
 * Delete one payment; false when it is not the user's. Vendor-sourced rows
 * TOMBSTONE (`deleted = true`) so the sync can never re-insert them — the
 * delete really is final, exactly as the confirm promises. Manual rows (null
 * vendor id) hard-delete: no sync path can ever re-create one.
 */
export async function deletePayment(userId: string, id: string): Promise<boolean> {
  const ownership = inArray(
    dividendPayments.portfolioId,
    db.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.userId, userId)),
  );

  const tombstoned = await db
    .update(dividendPayments)
    .set({ deleted: true, updatedAt: new Date() })
    .where(
      and(
        eq(dividendPayments.id, id),
        isNotNull(dividendPayments.vendorEventId),
        ownership,
      ),
    )
    .returning({ id: dividendPayments.id });
  if (tombstoned.length > 0) return true;

  const deleted = await db
    .delete(dividendPayments)
    .where(and(eq(dividendPayments.id, id), ownership))
    .returning({ id: dividendPayments.id });
  return deleted.length > 0;
}
