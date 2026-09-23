import { z } from 'zod';

import { OPTIONS_CHART_RANGES } from '@/lib/charts/ranges';
import {
  decimalString,
  isValidCalendarDate,
  optionPositionAddSchema,
  optionPositionEditSchema,
} from '@/lib/validation';

import {
  decimalStringSchema,
  directionSchema,
  displayStringSchema,
  isoDateSchema,
  uuidSchema,
} from './common';
import { trendDaysField } from './trend';
import { liveFigureSchema, liveMarketSchema, liveSummarySchema } from './live-payload';

/**
 * Options contracts — the mobile mirror of `src/lib/options/options-payload.ts`.
 *
 * The payload is composed by `composeLiveOptionsPayload`, which is isomorphic
 * by design (its own header: no `server-only`, no DB, no fetch). So the web
 * route `/api/quotes/options` and the mobile `/api/mobile/v1/options` return
 * the SAME object from the SAME function, and this schema describes it once
 * for both the runtime check and the Swift codegen.
 *
 * Everything here is USD and stays USD. These figures never enter a PLN total:
 * `option_positions` never joins `instruments`/`transactions`, the two
 * summaries are never summed, and the phone reproduces that isolation by
 * giving the options store no type in common with `LiveStore` beyond the
 * shared display primitives below.
 *
 * The write side reuses `src/lib/validation.ts` verbatim, the
 * `watchlistAddRequestSchema` precedent — the phone must not get a laxer door
 * into the same table than the web form has.
 */

/**
 * One MEMBER lot of a card. A card can stand for several `option_positions`
 * rows, so every mutation addresses a LOT — this is what keeps each purchase
 * reachable and un-mutable-by-proxy.
 */
export const optionLotItemSchema = z.object({
  /** The `option_positions` row id — what edit and remove address. */
  id: uuidSchema,
  quantity: displayStringSchema,
  entryPrice: displayStringSchema,
  /** Formatted costs; null on zero — the existing convention. */
  fees: displayStringSchema.nullable(),
  /** pl-PL compact, e.g. `12 sie` — the menu label. */
  tradeDateLabel: displayStringSchema,
  /** Raw decimal strings + ISO date: the edit form's prefill. */
  tradeDate: isoDateSchema,
  quantityRaw: decimalStringSchema,
  entryPriceRaw: decimalStringSchema,
  feesRaw: decimalStringSchema,
});

export type OptionLotItemContract = z.output<typeof optionLotItemSchema>;

/** One card's fully formatted display state — strings only, no arithmetic left. */
export const optionCardItemSchema = z.object({
  /**
   * The CARD's identity (the OCC ticker, or `ticker#rowId` for a degenerate
   * group). Deliberately not a row id: a card can stand for several rows.
   */
  key: z.string(),
  ticker: z.string(),
  underlying: z.string(),
  contractType: z.enum(['call', 'put']),
  strikeLabel: displayStringSchema,
  strike: displayStringSchema,
  expirationDate: isoDateSchema,
  expiryLabel: displayStringSchema,
  /** NY-calendar days until expiry — negative once expired. A count, not money. */
  daysToExpiry: z.number().int(),
  expired: z.boolean(),
  quantity: displayStringSchema,
  entryPrice: displayStringSchema,
  fees: displayStringSchema.nullable(),
  /**
   * Always emitted by the composer; optional on the wire only so a phone
   * build ahead of the API deploy still decodes (the `trend` precedent).
   */
  totalCost: displayStringSchema.optional(),
  lots: z.array(optionLotItemSchema),
  lotCount: z.number().int(),
  /** The entry price above is a weighted average and the card says so. */
  entryIsAverage: z.boolean(),
  hasQuote: z.boolean(),
  price: displayStringSchema.nullable(),
  /**
   * The price is a MODEL ESTIMATE (Black-Scholes on the vendor's own implied
   * volatility), not a traded price. Every surface that renders the price must
   * label it — the label is the mitigation for pricing off a model, and it is
   * not optional on the phone either.
   */
  priceIsEstimate: z.boolean(),
  dayBasisLabel: displayStringSchema.nullable(),
  lastTradeLabel: displayStringSchema.nullable(),
  lastTradeBeyondLookback: z.boolean(),
  noTrade: z.boolean(),
  day: liveFigureSchema.nullable(),
  dayPct: liveFigureSchema.nullable(),
  /**
   * The five-session strip along the bottom of the Dashboard tile, oldest
   * first. Entries are nullable because an option's session is routinely a
   * HOLE — a thin contract that did not trade, an evening no model mark could
   * be produced for, or a pair whose two ends are different kinds of number.
   * A hole is not a flat day and the tile draws them differently.
   */
  trend: trendDaysField,
  pl: liveFigureSchema.nullable(),
  plPct: displayStringSchema,
  plDirection: directionSchema,
  /** Sort keys — raw decimals, never rendered. Null is unknown, never zero. */
  plRaw: decimalStringSchema.nullable(),
  valueRaw: decimalStringSchema.nullable(),
  breakEven: displayStringSchema,
  delta: displayStringSchema,
  gamma: displayStringSchema,
  theta: displayStringSchema,
  vega: displayStringSchema,
  impliedVolatility: displayStringSchema,
  openInterest: displayStringSchema,
});

export type OptionCardItemContract = z.output<typeof optionCardItemSchema>;

export const optionsPayloadSchema = z.object({
  market: liveMarketSchema,
  items: z.array(optionCardItemSchema),
  /** The VISIBLE total: USD-only, over UNEXPIRED lots. */
  summary: liveSummarySchema,
  summaryNotes: z.array(displayStringSchema),
  /** The same figures over EVERY lot — shown while expired ones are revealed. */
  allSummary: liveSummarySchema,
  allSummaryNotes: z.array(displayStringSchema),
  expiredCount: z.number().int(),
});

export type OptionsPayloadContract = z.output<typeof optionsPayloadSchema>;

/**
 * The contract-chain lookups. Both are DEGRADED-or-ok rather than
 * error-throwing, matching the Server Actions the web calls: a vendor hiccup
 * during an add must leave the form usable and say so, never surface as a
 * failed screen.
 */
export const optionExpirySchema = z.object({
  expirationDate: isoDateSchema,
  label: displayStringSchema,
});

export const optionExpirationsResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), expirations: z.array(optionExpirySchema) }),
  z.object({
    ok: z.literal(false),
    degraded: z.literal(true),
    reason: z.enum(['signed-out', 'unavailable']),
  }),
]);

export const optionContractRefSchema = z.object({
  ticker: z.string(),
  underlying: z.string(),
  contractType: z.enum(['call', 'put']),
  strikePrice: decimalStringSchema,
  expirationDate: isoDateSchema,
  sharesPerContract: decimalStringSchema,
  strikeLabel: displayStringSchema,
});

export const optionStrikesResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), contracts: z.array(optionContractRefSchema) }),
  z.object({
    ok: z.literal(false),
    degraded: z.literal(true),
    reason: z.enum(['signed-out', 'unavailable']),
  }),
]);

/* ---------------------------------------------------------------- queries */

export const optionExpirationsQuerySchema = z.object({
  underlying: z.string().trim().toUpperCase().min(1).max(20),
});

export const optionStrikesQuerySchema = z.object({
  underlying: z.string().trim().toUpperCase().min(1).max(20),
  expirationDate: isoDateSchema,
  contractType: z.enum(['call', 'put']),
});

/**
 * The import wizard's verification gate — the bearer twin of
 * `matchOptionContract` in `(app)/options/actions.ts`. Same shape as its own
 * `matchInputSchema`: `underlying` OR `companyName`, never neither, is
 * enforced by the handler (a `.refine` here cannot express "at least one of"
 * across two independently-optional fields without losing per-field error
 * messages, and the handler already has to branch on which one is present).
 */
export const optionMatchRequestSchema = z.object({
  underlying: z
    .string()
    .trim()
    .regex(/^[A-Z0-9.]{1,10}$/)
    .optional(),
  companyName: z.string().trim().min(1).max(80).optional(),
  contractType: z.enum(['call', 'put']),
  strikePrice: decimalString({ positive: true }),
  expirationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isValidCalendarDate),
});

export const optionMatchResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('matched'), contract: optionContractRefSchema }),
  z.object({ status: z.literal('nearby'), alternatives: z.array(optionContractRefSchema) }),
  z.object({ status: z.literal('unresolved') }),
  z.object({ status: z.literal('degraded'), reason: z.enum(['signed-out', 'unavailable']) }),
]);

/**
 * The options chart's OWN five ranges. Reusing the eight-range chart enum
 * would offer `1D`/`5D`, which this series answers empty for by construction
 * (the marks are daily) — a tab that always draws nothing.
 */
export const optionsRangeQuerySchema = z.object({
  range: z.enum(OPTIONS_CHART_RANGES),
  /**
   * ONE contract's own series, addressed by its OCC TICKER — not by the card
   * `key`, which can be `ticker#rowId` for a degenerate group and would match
   * no row. The web detail page passes `item.ticker` for the same reason.
   * Absent means the whole tracked book.
   */
  ticker: z.string().trim().min(1).max(64).optional(),
});

/* ---------------------------------------------------------------- writes */

/**
 * Request bodies, reused verbatim from `src/lib/validation.ts`. They are NOT
 * generated into Swift — request types are hand-written against
 * `validation.ts` as the spec, because a JSON Schema describes a shape and
 * these carry transforms (trims, the pl-PL comma normalisation) whose
 * post-transform value the client never actually sends. See
 * `scripts/gen-swift-contracts.mjs`.
 */
export const optionPositionAddRequestSchema = optionPositionAddSchema;
export const optionPositionEditRequestSchema = optionPositionEditSchema;
