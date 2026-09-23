import { z } from 'zod';

import { portfolioNameSchema } from '@/lib/validation';

import { uuidSchema } from './common';

/**
 * Portfolio contracts. The name rules are NOT restated here — they are
 * imported from `src/lib/validation.ts`, which the web forms already use, so
 * a bound that changes changes in one place and both callers move together.
 */

export const portfolioSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  /** Display order — an index, not money. */
  sortOrder: z.number().int(),
  /** Transactions held, for the chip's meta line. */
  txCount: z.number().int(),
});

export type PortfolioContract = z.output<typeof portfolioSchema>;

export const portfolioListSchema = z.object({
  portfolios: z.array(portfolioSchema),
});

export const portfolioCreateSchema = z.object({
  name: portfolioNameSchema,
});

export const portfolioRenameSchema = z.object({
  name: portfolioNameSchema,
});

/**
 * Absolute reorder — the FULL id list in the order the user dropped them
 * into. A partial or stale list is rejected by the handler rather than
 * patched, exactly as in the Server Action: holes and ties in `sortOrder` are
 * worse than an error the client can retry after a reload.
 */
export const portfolioReorderSchema = z.object({
  ids: z.array(uuidSchema).min(1).max(500),
});

/** A create answers with the new id, so the client can select the new scope. */
export const portfolioCreatedSchema = z.object({
  ok: z.literal(true),
  id: uuidSchema,
});
