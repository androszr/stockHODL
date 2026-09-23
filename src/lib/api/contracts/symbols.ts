import { z } from 'zod';

import { MAX_SEARCH_QUERY_LENGTH } from '@/lib/market-data/symbol-search';

import { currencySchema } from './common';

/**
 * Symbol search — the transaction form's combobox.
 *
 * The READ shape is stated here because nothing on the web serializes a
 * `SymbolMatch` through a contract today: `/api/symbols/search` hands its
 * objects straight to `Response.json`. This schema is the wire description
 * the phone decodes, and `symbolSearchResponseSchema` validates the mobile
 * route's own output in a test so the two cannot come apart.
 *
 * `currency` is optional on purpose and not defaulted: `symbol-search.ts` only
 * stamps it when the exchange is confidently mapped, and inventing a 'USD' for
 * an unmapped result would mint an instrument in the wrong currency —
 * permanently, because `instruments` is global and first-write-wins.
 */

export const symbolMatchSchema = z.object({
  /** Ticker in provider notation — class shares use dots, e.g. `BRK.A`. */
  symbol: z.string(),
  name: z.string(),
  /** Exchange identifier — for US results this is the display name itself. */
  exchange: z.string(),
  /** Human-readable exchange, e.g. `NYSE` — what the form field receives. */
  exchangeDisplay: z.string(),
  type: z.enum(['equity', 'etf']).meta({ title: 'SymbolMatchKind' }),
  currency: currencySchema.optional(),
});

export type SymbolMatchContract = z.output<typeof symbolMatchSchema>;

export const symbolSearchResponseSchema = z.object({
  results: z.array(symbolMatchSchema),
  /**
   * Only ever `true`, and only when the provider failed AND the local
   * directory had nothing. It means "search is broken, type it in yourself" —
   * which is a lie while the fallback still works, hence the narrow condition.
   */
  degraded: z.literal(true).optional(),
});

/**
 * The query. Bounds mirror the web route's, because they ARE the web route's
 * — both handlers read the same constant.
 */
export const symbolSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH),
});
