import { z } from 'zod';

import { transactionInputSchema } from '@/lib/validation';

import { currencySchema, decimalStringSchema, isoDateSchema, uuidSchema } from './common';

/**
 * Transaction contracts.
 *
 * The WRITE side is `transactionInputSchema` from `src/lib/validation.ts`
 * verbatim — the same schema the web form and the Server Action validate
 * with, including the comma-separator normalization, the thousands-grouping
 * refusal, the FX-required-for-non-PLN rule and the PLN→'1' transform. The
 * mobile client gets the identical contract for free, and a rule that moves
 * moves for both clients at once.
 *
 * The READ side is stated here, because nothing on the web serializes a bare
 * transaction row today (the pages render it straight into JSX).
 */

export const transactionCreateSchema = transactionInputSchema;
export const transactionUpdateSchema = transactionInputSchema;

/**
 * One stored transaction, as the client reads it back. Amounts are the raw
 * `numeric` values as decimal strings — NOT display text: the mobile client
 * formats with its own pl-PL formatters, and an edit form needs the stored
 * value, not a grouped one it would have to parse back.
 */
export const transactionRowSchema = z.object({
  id: uuidSchema,
  portfolioId: uuidSchema,
  portfolioName: z.string(),
  instrumentId: uuidSchema,
  symbol: z.string(),
  displayName: z.string(),
  /**
   * Read back so an EDIT form has the stored value instead of inventing one.
   * `updateTransaction` never writes it — the instrument is locked — but the
   * write schema still requires the field, and a client that had to make one
   * up would be sending a fiction the server merely happens to discard.
   */
  exchange: z.string(),
  currency: currencySchema,
  side: z.enum(['buy', 'sell']).meta({ title: 'TransactionSide' }),
  quantity: decimalStringSchema,
  price: decimalStringSchema,
  fees: decimalStringSchema,
  tradeDate: isoDateSchema,
  fxRateToBase: decimalStringSchema,
  note: z.string().nullable(),
});

export type TransactionRowContract = z.output<typeof transactionRowSchema>;

export const transactionListSchema = z.object({
  transactions: z.array(transactionRowSchema),
});

/**
 * Optional narrowing for the list read. Absent means "everything", which is
 * what the transactions screen asks for; `symbol` backs the instrument
 * screen's row list without a second endpoint.
 */
export const transactionListQuerySchema = z.object({
  portfolioId: uuidSchema.optional(),
  symbol: z.string().trim().toUpperCase().min(1).max(20).optional(),
});

export const transactionCreatedSchema = z.object({
  ok: z.literal(true),
  id: uuidSchema,
});
