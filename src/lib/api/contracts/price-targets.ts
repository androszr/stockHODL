import { z } from 'zod';

import { decimalString } from '@/lib/validation';

import { decimalStringSchema, displayStringSchema, epochMsSchema, uuidSchema } from './common';

/**
 * Price targets (plans/2026-09-05-price-target-alerts.md): the lines a user
 * draws on a stock. The LIST rides inside the instrument detail payload —
 * there is deliberately no standalone GET route, because the instrument
 * screen is the list's only consumer and it already makes exactly one fetch.
 * Both mutation routes answer `priceTargetsResponseSchema` (the instrument's
 * fresh list) so the screen stays consistent after a write without refetching
 * the whole payload.
 */

/**
 * Which way the line is crossed, derived from the current price at CREATION
 * and persisted — never re-inferred at check time. Named (rather than inlined
 * in `priceTargetSchema`) so the codegen registers one `TargetDirection` type
 * instead of colliding with the display `Direction` enum.
 */
export const targetDirectionSchema = z.enum(['up', 'down']);

export const priceTargetSchema = z.object({
  id: uuidSchema,
  instrumentId: uuidSchema,
  /** Money stays a decimal string on the wire — formatted on the phone. */
  targetPrice: decimalStringSchema,
  direction: targetDirectionSchema,
  /** Null = still waiting. Epoch ms, the `nextTransitionAtMs` convention. */
  hitAtMs: epochMsSchema.nullable(),
  createdAtMs: epochMsSchema,
});

export type PriceTargetContract = z.output<typeof priceTargetSchema>;

/** The create body. The price bound is IMPORTED from `validation.ts`, never
 *  restated — the same `decimalString` every money input in the app parses
 *  through, comma normalisation and grouping refusal included. */
export const priceTargetCreateRequestSchema = z.object({
  instrumentId: uuidSchema,
  targetPrice: decimalString({ positive: true }),
});

/**
 * Where the CURRENT price sits relative to the nearest waiting line —
 * `below` = the price is under the line (it must RISE to reach it). Live,
 * never the persisted `direction`: a pending line the price gapped past
 * (cron lag) must still read from where the price is NOW, or the arrow
 * points away from the line. Named so the codegen registers one `TargetSide`
 * type (the `TargetDirection` precedent).
 */
export const targetSideSchema = z.enum(['above', 'below']);

export type TargetSideContract = z.output<typeof targetSideSchema>;

/**
 * The proximity readout for one instrument's target lines, composed by
 * `src/lib/alerts/target-proximity.ts` — the ONE producer the watchlist
 * tiles, the instrument screen and both mutation responses share, so the
 * surfaces can never tell different stories.
 *
 * Both strings are server-formatted (non-negotiable #1): `text` is the
 * compact unsigned distance for a tile ("3,21%", "Hit", "—"), `sentence` the
 * full readout ("3,21% below your 190,00 USD line") — also the accessibility
 * label, so the state is words, never a glyph or a color alone.
 */
export const targetStatusSchema = z.object({
  text: displayStringSchema,
  sentence: displayStringSchema,
  /** Null when the distance is zero, when no usable price exists, or when
   *  only hit lines remain — there is no direction to point. */
  side: targetSideSchema.nullable(),
  /** Within the 5% threshold (inclusive) of the nearest waiting line. */
  near: z.boolean(),
  /** Every line this instrument has was already hit — files under "No
   *  target", but the tile says "Hit" so the history is not invisible. */
  hitOnly: z.boolean(),
});

export type TargetStatusContract = z.output<typeof targetStatusSchema>;

/**
 * What BOTH mutation routes answer: the affected instrument's fresh list,
 * plus the recomputed proximity status (null when no lines remain — or when
 * an idempotent no-op delete left the instrument unknowable).
 */
export const priceTargetsResponseSchema = z.object({
  targets: z.array(priceTargetSchema),
  status: targetStatusSchema.nullable(),
});
