import { z } from 'zod';

import {
  currencySchema,
  decimalStringSchema,
  directionSchema,
  displayStringSchema,
  uuidSchema,
} from './common';
import { cachedPriceSchema, extendedFigureSchema, liveFigureSchema } from './live-payload';
import { priceTargetSchema, targetStatusSchema } from './price-targets';
import { transactionRowSchema } from './transactions';

/**
 * The instrument screen's payload — identity, the position figures, the live
 * quote figures, the session stats row, the per-portfolio groups and the
 * transaction rows. News and the dividend ROWS are still NOT in here and
 * deliberately so: both are their own endpoints the client already speaks,
 * and folding them in would make every instrument open pay for data a user
 * may never scroll to. `hasDividends` is the one exception — a cheap
 * existence check the Dividends link gates on, not the rows themselves.
 *
 * The symbol in the URL only ever resolves to an instrument the directory
 * knows. An unknown ticker is a 404, indistinguishable from one that never
 * existed.
 */

/** The six-cell figure set, `HoldingDetailData`-shaped, pre-formatted. */
export const positionFiguresSchema = z.object({
  currency: currencySchema,
  quantity: displayStringSchema,
  /** Null when quantity is zero (oversold-at-zero rows). */
  avgCost: displayStringSchema.nullable(),
  costBasisPLN: displayStringSchema,
  unrealizedPLN: displayStringSchema.nullable(),
  unrealizedPct: displayStringSchema,
  direction: directionSchema,
  valuePLN: displayStringSchema.nullable(),
  oversold: z.boolean(),
});

export const portfolioGroupSchema = z.object({
  portfolioId: uuidSchema,
  portfolioName: z.string(),
  summary: positionFiguresSchema,
});

/**
 * The Yahoo-style session stats under the header, pre-formatted. Every field
 * is nullable and a null renders '—' — never a fabricated 0, which on an
 * unopened stock would be a claim rather than a gap. Outside regular hours
 * the vendor's session object describes the last COMPLETED session, and it is
 * passed through as-is (Yahoo behaves the same way).
 */
export const dayStatsSchema = z.object({
  prevClose: displayStringSchema.nullable(),
  /** Named `dayOpen`, not `open`: `open` is a Swift keyword, and the codegen
   *  answers one with a mangled `dayStatsOpen` property. Matching its
   *  `dayLow`/`dayHigh` siblings is the better name anyway. */
  dayOpen: displayStringSchema.nullable(),
  dayLow: displayStringSchema.nullable(),
  dayHigh: displayStringSchema.nullable(),
  /** Share COUNT, grouped pl-PL — a tally, not money. */
  volume: displayStringSchema.nullable(),
  vwap: displayStringSchema.nullable(),
});

/**
 * 52-week extremes as display strings plus the raw decimals the phone needs
 * for the range-bar geometry. `currentRaw` is null when there is no
 * currency-matching headline — labels still render, the marker does not.
 */
export const week52RangeSchema = z.object({
  low: displayStringSchema,
  high: displayStringSchema,
  lowRaw: decimalStringSchema,
  highRaw: decimalStringSchema,
  currentRaw: decimalStringSchema.nullable(),
});

/** Company facts for the About panel. Every field independently nullable. */
export const aboutSchema = z.object({
  description: z.string().nullable(),
  marketCap: displayStringSchema.nullable(),
  employees: displayStringSchema.nullable(),
  website: z.string().nullable(),
  week52: week52RangeSchema.nullable(),
});

export const instrumentResponseSchema = z.object({
  instrumentId: uuidSchema,
  symbol: z.string(),
  displayName: z.string(),
  currency: currencySchema,
  exchange: z.string(),
  /** True when the user holds transactions in it (as opposed to only watching). */
  owned: z.boolean(),
  /** True when it sits on the user's watchlist. */
  watched: z.boolean(),
  /** True when the user has at least one dividend payment for it — never the
   *  rows, just the existence check the Dividends link gates on. */
  hasDividends: z.boolean(),
  /** Absent on a purely watched instrument — there is no position to show. */
  position: positionFiguresSchema.nullable(),
  /** Live quote figures, `quoteFigures()` output. Nulls mean "—", never zero. */
  price: displayStringSchema.nullable(),
  /**
   * The last SAVED price, sent only when no live price exists. Display-only
   * and labelled with its FETCH instant on the client — never presented as a
   * trade time, and never priced from.
   */
  cachedPrice: cachedPriceSchema.nullable(),
  dayPct: liveFigureSchema.nullable(),
  extended: extendedFigureSchema.nullable(),
  dayStats: dayStatsSchema,
  about: aboutSchema,
  /** One group per portfolio holding rows, in the Portfolios screen's order. */
  groups: z.array(portfolioGroupSchema),
  transactions: z.array(transactionRowSchema),
  /** THIS user's price targets on the instrument — empty for a browsed
   *  instrument with none. The list's only home; there is no GET-list route. */
  priceTargets: z.array(priceTargetSchema),
  /** The proximity sentence above the target rows — the same calculation the
   *  watchlist tiles use (`target-proximity.ts`), so the two can never tell
   *  different stories. Null when the instrument has no lines. */
  targetStatus: targetStatusSchema.nullable(),
});

export type InstrumentResponseContract = z.output<typeof instrumentResponseSchema>;
