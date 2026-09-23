import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db, optionPositions } from '@/lib/db';
import { invalidateDayReportMemo } from '@/lib/day-report/view';
import type {
  OptionPositionAddInput,
  OptionPositionEditInput,
} from '@/lib/validation';

/**
 * The three option-lot writes, extracted from
 * `src/app/(app)/options/actions.ts` (2026-08-18) so the Server Actions and
 * `/api/mobile/v1/options` share one body — the `src/lib/transactions/
 * mutations.ts` arrangement, for the same reason: two doors into one table
 * must not be able to enforce two different sets of rules.
 *
 * VALIDATION IS THE CALLER'S. Both entry points parse with the schemas in
 * `src/lib/validation.ts` first and hand these functions the parsed output,
 * so the phone cannot get a laxer door than the web form has.
 *
 * Every mutation addresses a LOT, never a card: a card can stand for several
 * `option_positions` rows, and a mutation keyed on a card would land on a
 * purchase the user did not name.
 */

export async function insertOptionPosition(
  userId: string,
  input: OptionPositionAddInput,
): Promise<void> {
  await db.insert(optionPositions).values({
    userId,
    ticker: input.ticker,
    underlying: input.underlying,
    contractType: input.contractType,
    strikePrice: input.strikePrice,
    expirationDate: input.expirationDate,
    sharesPerContract: input.sharesPerContract,
    quantity: input.quantity,
    entryPrice: input.entryPrice,
    tradeDate: input.tradeDate,
    fees: input.fees,
  });
  invalidateDayReportMemo(userId);
}

/**
 * LOT FIELDS ONLY. Contract identity (ticker/strike/expiry/type) is refused
 * BY SCHEMA upstream (`optionPositionEditSchema` is strict), not by being
 * ignored here: changing the contract is really a different position, handled
 * by remove + re-add.
 *
 * Scoped by `userId`: a foreign or unknown id updates nothing and the caller
 * still reports ok — idempotent, and nothing here is enumerable.
 */
export async function editOptionPosition(
  userId: string,
  input: OptionPositionEditInput,
): Promise<void> {
  await db
    .update(optionPositions)
    .set({
      quantity: input.quantity,
      entryPrice: input.entryPrice,
      tradeDate: input.tradeDate,
      fees: input.fees,
    })
    .where(and(eq(optionPositions.userId, userId), eq(optionPositions.id, input.id)));
  invalidateDayReportMemo(userId);
}

/** Scoped delete, idempotent for the same reason the edit is. */
export async function deleteOptionPosition(userId: string, id: string): Promise<void> {
  await db
    .delete(optionPositions)
    .where(and(eq(optionPositions.userId, userId), eq(optionPositions.id, id)));
  invalidateDayReportMemo(userId);
}
