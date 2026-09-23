import { z } from 'zod';

import { decimalStringSchema, isoDateSchema, uuidSchema } from './common';

/**
 * Dividends — the phone's read of `/dividends`.
 *
 * Every amount is a decimal STRING, including the ones the server already
 * folded (`netPLN`, the per-year totals). The folding happens once, in
 * `src/lib/dividends/summary.ts`, over `Decimal` — the phone must never
 * re-add a column, because two folds of the same rows are two chances to
 * disagree about what the year was worth.
 *
 * The two "excluded" counts travel separately and BOTH of them travel:
 * `awaitingFx` is a row the next NBP sync can still rate, `fxUnsupported` is
 * a currency with no PLN route at all, and collapsing them into one "missing"
 * number would turn a permanent state into one that looks like it is coming.
 * The screen says which is which because the wire does.
 */

export const dividendPaymentSchema = z.object({
  id: uuidSchema,
  portfolioId: uuidSchema,
  portfolioName: z.string(),
  instrumentId: uuidSchema,
  symbol: z.string(),
  displayName: z.string(),
  exDate: isoDateSchema,
  /** Null while the payment is announced but not yet paid. */
  payDate: isoDateSchema.nullable(),
  quantity: decimalStringSchema,
  amountPerShare: decimalStringSchema,
  grossAmount: decimalStringSchema,
  withheldTax: decimalStringSchema,
  /** Derived `gross − withheld` server-side; never re-derived on the phone. */
  netAmount: decimalStringSchema,
  currency: z.string(),
  /** Frozen D-1 NBP rate at the payment date; null until published. */
  fxRateToBase: decimalStringSchema.nullable(),
  /** `'massive'` came from the vendor sync, `'manual'` was typed by hand. */
  source: z.enum(['massive', 'manual']),
  /** A vendor row the user has since corrected — the sync leaves it alone. */
  edited: z.boolean(),
  note: z.string().nullable(),
});

export type DividendPaymentContract = z.output<typeof dividendPaymentSchema>;

export const dividendYearTotalSchema = z.object({
  currency: z.string(),
  gross: decimalStringSchema,
  withheld: decimalStringSchema,
  net: decimalStringSchema,
});

export const dividendYearGroupSchema = z.object({
  /** 'YYYY'. */
  year: z.string(),
  /** Payment-date descending within the year. */
  paymentIds: z.array(uuidSchema),
  totals: z.array(dividendYearTotalSchema),
  /** Null when no row in the year carries a rate. */
  netPLN: decimalStringSchema.nullable(),
  awaitingFx: z.number().int(),
  fxUnsupported: z.number().int(),
});

export type DividendYearGroupContract = z.output<typeof dividendYearGroupSchema>;

export const dividendSummarySchema = z.object({
  netPLN: decimalStringSchema.nullable(),
  ytdNetPLN: decimalStringSchema.nullable(),
  /** Payment rows in scope — a count, not money. */
  count: z.number().int(),
  awaitingFx: z.number().int(),
  fxUnsupported: z.number().int(),
});

export type DividendSummaryContract = z.output<typeof dividendSummarySchema>;

/**
 * Rows and grouping travel as two lists rather than one nested tree: the
 * groups reference `paymentIds`, and the phone joins them. A nested payload
 * would repeat every row inside its year, and this list is the one screen
 * where a five-year history is the ordinary case.
 */
export const dividendsResponseSchema = z.object({
  payments: z.array(dividendPaymentSchema),
  years: z.array(dividendYearGroupSchema),
  summary: dividendSummarySchema,
});

export type DividendsResponse = z.output<typeof dividendsResponseSchema>;

/**
 * The instruments a manual payment may attach to — the user's own TRANSACTED
 * set, which is the same list the web form's dropdown is built from. A
 * dividend can never mint an instrument, on either client, so this read is
 * what makes the phone's picker possible at all.
 */
export const dividendInstrumentSchema = z.object({
  id: uuidSchema,
  symbol: z.string(),
  displayName: z.string(),
  currency: z.string(),
});

export const dividendInstrumentListSchema = z.object({
  instruments: z.array(dividendInstrumentSchema),
  /** Portfolios to file a payment under, in display order. */
  portfolios: z.array(
    z.object({ id: uuidSchema, name: z.string() }),
  ),
});

export type DividendInstrumentListContract = z.output<typeof dividendInstrumentListSchema>;
