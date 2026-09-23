import { z } from 'zod';

import { dec } from '@/lib/money';
import {
  CURRENCIES,
  dateStringSchema,
  decimalString,
  normalizeDecimalSeparator,
} from '@/lib/validation';

/**
 * Input schemas for the dividend-payment actions — isomorphic (no server
 * marker, no env, no DB), imported by the Server Actions for authoritative
 * validation and by the form for pre-submit UX, exactly like
 * `src/lib/validation.ts`. Money strings go through `decimalString` (comma
 * tolerated as the decimal separator, bounds matching the numeric columns);
 * nothing here ever float-parses an amount.
 */

const optionalDateSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  dateStringSchema.optional(),
);

/** Optional FX-to-PLN override: numeric(20,10) bounds, empty means "not
 *  published yet" — stored as NULL and shown as an honest dash. */
const optionalFxSchema = z.preprocess(
  normalizeDecimalSeparator,
  z
    .string()
    .optional()
    .superRefine((v, ctx) => {
      if (v === undefined || v === '') return;
      const probe = decimalString({ positive: true, maxIntegerDigits: 10, maxScale: 10 }).safeParse(v);
      if (!probe.success) {
        ctx.addIssue({
          code: 'custom',
          message: probe.error.issues[0]?.message ?? 'Enter a valid rate',
        });
      }
    })
    .transform((v) => (v === '' ? undefined : v)),
);

const paymentFields = {
  portfolioId: z.uuid('Pick a portfolio'),
  exDate: dateStringSchema,
  payDate: optionalDateSchema,
  quantity: decimalString({ positive: true }),
  amountPerShare: decimalString({ positive: true }),
  grossAmount: decimalString({ positive: true }),
  withheldTax: z.preprocess(
    (v) => (v == null || v === '' ? '0' : v),
    decimalString({ nonNegative: true }),
  ),
  currency: z.enum(CURRENCIES, { message: 'Unsupported currency' }),
  fxRateToBase: optionalFxSchema,
  note: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(500).optional(),
  ),
};

/** Withheld tax exceeding the gross would make net negative — a typo, refused. */
function refineWithheld(
  val: { withheldTax: string; grossAmount: string },
  ctx: z.RefinementCtx,
) {
  if (dec(val.withheldTax).greaterThan(dec(val.grossAmount))) {
    ctx.addIssue({
      code: 'custom',
      path: ['withheldTax'],
      message: "Withheld tax can't exceed the gross amount",
    });
  }
}

/** Manual add: the instrument is chosen from the user's own transacted set. */
export const dividendCreateSchema = z
  .object({ instrumentId: z.uuid('Pick an instrument'), ...paymentFields })
  .superRefine(refineWithheld);

export type DividendCreateInput = z.output<typeof dividendCreateSchema>;

/**
 * Edit: every stored figure, but NOT the instrument or currency — a
 * different company or currency is a different payment (the transaction
 * instrument-lock precedent; delete + re-add is the path).
 */
export const dividendUpdateSchema = z
  .object({
    portfolioId: paymentFields.portfolioId,
    exDate: paymentFields.exDate,
    payDate: paymentFields.payDate,
    quantity: paymentFields.quantity,
    amountPerShare: paymentFields.amountPerShare,
    grossAmount: paymentFields.grossAmount,
    withheldTax: paymentFields.withheldTax,
    fxRateToBase: paymentFields.fxRateToBase,
    note: paymentFields.note,
  })
  .superRefine(refineWithheld);

export type DividendUpdateInput = z.output<typeof dividendUpdateSchema>;
