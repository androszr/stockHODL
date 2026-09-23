import { z } from 'zod';

import { portfolioTargetsPutSchema } from '@/lib/validation';

import { decimalStringSchema, uuidSchema } from './common';

/**
 * Per-portfolio target weights (plans/2026-09-05-target-weights-drift.md):
 * the mix a portfolio is SUPPOSED to have. The drift readout itself rides
 * inside the analytics payload (`analyticsTargetDriftSchema`); these two
 * shapes are the edit sheet's own door — a GET to seed the fields from the
 * server rather than from a possibly-stale disk cache, and a bulk-replace
 * PUT.
 *
 * A target is a SHARE, not money, so it travels as a bare decimal string
 * with no currency attached — but it multiplies money downstream, which is
 * why there is no number type here either.
 *
 * Blank ≠ zero: a cleared field is an OMITTED row, never `targetPct: '0'`,
 * and the bound below refuses a zero outright so the rule cannot be broken
 * by a client that gets it wrong.
 */

export const targetRowSchema = z
  .object({
    instrumentId: uuidSchema,
    /**
     * The ticker the target is against. Carried so the edit sheet can show a
     * row for a stored target the (possibly stale) analytics payload does not
     * list — without it, such a target would either be invisible or shown
     * against an invented name, and a bulk-replace save would delete it
     * without a word.
     */
    symbol: z.string().min(1),
    /** Percent of the portfolio, 0 < x ≤ 100. */
    targetPct: decimalStringSchema,
  })
  .meta({ title: 'TargetRow' });

export type TargetRowContract = z.output<typeof targetRowSchema>;

export const targetsResponseSchema = z
  .object({
    rows: z.array(targetRowSchema),
  })
  .meta({ title: 'TargetsResponse' });

export type TargetsResponse = z.output<typeof targetsResponseSchema>;

/**
 * The bulk-replace body. IMPORTED from `validation.ts` rather than restated,
 * so the bound that refuses `0`, `100.01` and a third decimal place changes
 * in exactly one place (the `transactionInputSchema` discipline).
 */
export const targetsPutRequestSchema = portfolioTargetsPutSchema;
