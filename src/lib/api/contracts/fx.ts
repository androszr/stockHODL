import { z } from 'zod';

import { CURRENCIES } from '@/lib/validation';

import { decimalStringSchema, isoDateSchema } from './common';

/**
 * D-1 NBP rate lookup (art. 11a PIT/CIT) — the transaction form's FX autofill,
 * as an endpoint instead of a Server Action.
 *
 * The "market data is server-mediated" rule covers NBP exactly as it covers
 * the quote vendor: the native client asks THIS host for a rate and never
 * learns that `api.nbp.pl` exists. `src/lib/fx/nbp.ts` keeps sole ownership of
 * the vendor URL and the `fx_rates` read-through cache.
 *
 * PLN is excluded at the schema level, mirroring `fxLookupSchema` in the
 * Server Action: the client short-circuits to '1' and asking NBP for a
 * PLN/PLN rate is a bug, not a request.
 */

export const fxRateQuerySchema = z.object({
  currency: z.enum(CURRENCIES).exclude(['PLN']),
  tradeDate: isoDateSchema,
});

/**
 * Discriminated on `ok` so quicktype emits something the Swift side can
 * switch over. The failure reasons are carried verbatim from
 * `FxRateResult` — the client distinguishes "NBP has not published yet" from
 * "the vendor is down", because only the second is worth retrying.
 */
export const fxRateResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** NBP mid rate to PLN, decimal string. */
    rate: decimalStringSchema,
    /** The business day the rate was published for — the D-1 day. */
    rateDate: isoDateSchema,
  }),
  z.object({
    ok: z.literal(false),
    reason: z
      .enum(['no_rate', 'not_published', 'unavailable', 'invalid'])
      // `title` names the generated Swift type; without it quicktype calls
      // this one `Reason`, which says nothing at a call site.
      .meta({ title: 'FxRateFailureReason' }),
  }),
]);

export type FxRateResponseContract = z.output<typeof fxRateResponseSchema>;
