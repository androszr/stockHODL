import { z } from 'zod';

import { CURRENCIES, dateStringSchema } from '@/lib/validation';

/**
 * Shared primitives for the `/api/mobile/v1/*` contracts.
 *
 * These schemas are the SOURCE OF TRUTH for the native client's generated
 * Swift structs (`pnpm contracts:gen` → `ios/StockHODL/Generated/`), and they
 * are used at runtime by the route handlers — a schema nobody parses with
 * rots, so every one of them earns its keep by validating either an incoming
 * body or an outgoing payload in a test.
 *
 * Isomorphic by construction: no `server-only`, no database, no env. The
 * codegen script imports this tree from plain Node.
 *
 * MONEY: every amount crosses the wire as a decimal STRING. There is no
 * number type for money anywhere in this file, so quicktype cannot emit a
 * `Double` for one. Conversion to `Decimal` happens in the Swift mapping
 * layer, never in a generated struct.
 */

export const uuidSchema = z.uuid();

/** Plain 'YYYY-MM-DD', calendar-checked — the same helper the forms use. */
export const isoDateSchema = dateStringSchema;

export const currencySchema = z.enum(CURRENCIES);

/**
 * An amount on the wire. Deliberately just `z.string()`: the value has
 * already been produced by `toNumeric`/`fmtMoney` server-side, so re-running
 * the bounds checks from `validation.ts` here would only be able to reject
 * our own output. Inputs use `decimalString()` from `validation.ts`, which
 * does bound them.
 */
export const decimalStringSchema = z.string();

/** Pre-formatted display text (pl-PL) — never parsed back into a number. */
export const displayStringSchema = z.string();

/** Epoch milliseconds. A timestamp is not money; a number is correct here. */
export const epochMsSchema = z.number().int();

export const directionSchema = z.enum(['gain', 'loss', 'neutral']);

/**
 * The single error shape every mobile endpoint answers with. One field, so
 * the Swift side has exactly one thing to decode on any non-2xx.
 */
export const errorResponseSchema = z.object({
  error: z.string(),
});

export type ErrorResponse = z.output<typeof errorResponseSchema>;

/** `{ ok: true }` — the answer of a mutation that has nothing to return. */
export const okResponseSchema = z.object({
  ok: z.literal(true),
});

export type OkResponse = z.output<typeof okResponseSchema>;
