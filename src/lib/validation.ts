import { z } from 'zod';

import { nyDateISOAt } from '@/lib/market-data/market-clock';
import { dec } from '@/lib/money';

/**
 * Isomorphic input schemas — imported by both Server Actions (authoritative
 * validation) and client forms (pre-submit UX). Deliberately no server marker:
 * this module reads neither env nor the database.
 *
 * Decimal checks construct a Decimal via `dec()` and inspect it. A money or
 * quantity string never passes through float parsing here.
 */

function isDecimalString(value: string): boolean {
  try {
    return dec(value).isFinite();
  } catch {
    return false;
  }
}

/**
 * A comma followed by exactly three digits at the end of the value, with a
 * non-zero integer part: '1,000', '12,345'. That is indistinguishable from
 * thousands grouping, and normalizing it would silently store 1 instead of
 * 1000 — a 1000x error with no warning. We refuse to guess and reject with a
 * targeted message instead.
 *
 * Deliberate carve-out: a '0' integer part ('0,125') is never grouping —
 * nobody writes 0,125 to mean 125 — so it stays a valid decimal. That keeps
 * fractional-share entry possible on the pl-PL mobile pad, whose only
 * separator key is the comma. A rejected '1,250'-style value can always be
 * written unambiguously as '1250' or '1,2500'.
 */
const AMBIGUOUS_GROUPING = /^-?(?!0,)\d+,\d{3}$/;

/**
 * The pl-PL mobile numeric pad offers only a COMMA as its separator key, so a
 * lone comma must be accepted as the decimal point. Normalized once, here —
 * never at call sites. Exactly one comma and no dot is unambiguous (except
 * the thousands-grouping shape above, which is left alone so `decimalIssue`
 * can reject it by name); anything mixed ('1.234,5') or repeated ('1,2,3')
 * is also left as-is and fails the decimal check rather than being guessed.
 */
export function normalizeDecimalSeparator(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (AMBIGUOUS_GROUPING.test(trimmed)) return trimmed;
  if (trimmed.includes(',') && !trimmed.includes('.')) {
    const swapped = trimmed.replace(',', '.');
    if (!swapped.includes(',')) return swapped; // there was exactly one comma
  }
  return trimmed;
}

interface DecimalBounds {
  positive?: boolean;
  nonNegative?: boolean;
  /** Max digits before the separator. 12 stays well inside numeric(20,8). */
  maxIntegerDigits?: number;
  /** Max digits after the separator — the storage scale. */
  maxScale?: number;
}

/**
 * Full validity check for a (already separator-normalized) decimal string,
 * bounded to what the numeric columns can actually store. Returns the issue
 * message, or null when valid.
 */
function decimalIssue(value: string, opts: DecimalBounds): string | null {
  if (AMBIGUOUS_GROUPING.test(value)) {
    return 'That reads as a thousands separator — enter the number without grouping (e.g. 1000 or 1000,50)';
  }
  if (value.length === 0 || !isDecimalString(value)) return 'Enter a valid number';
  const d = dec(value);
  if (opts.positive && !d.greaterThan(0)) return 'Must be greater than zero';
  if (opts.nonNegative && !d.greaterThanOrEqualTo(0)) return 'Must not be negative';

  const maxIntegerDigits = opts.maxIntegerDigits ?? 12;
  const maxScale = opts.maxScale ?? 8;
  if (d.abs().greaterThanOrEqualTo(dec(10).pow(maxIntegerDigits))) {
    return `Keep the value under ${maxIntegerDigits} digits`;
  }
  // A non-zero value must survive storage rounding: silently persisting a
  // zero-quantity trade that validation swore was positive is a data hole.
  if (!d.isZero() && dec(d.toFixed(maxScale)).isZero()) {
    return `Too small to store — the smallest step is 1e-${maxScale}`;
  }
  if (d.decimalPlaces() > maxScale) {
    return `Use at most ${maxScale} decimal places`;
  }
  return null;
}

/** A bounded decimal string; accepts a lone comma as the decimal separator. */
export function decimalString(opts: DecimalBounds = {}) {
  return z.preprocess(
    normalizeDecimalSeparator,
    z.string().superRefine((v, ctx) => {
      const issue = decimalIssue(v, opts);
      if (issue) ctx.addIssue({ code: 'custom', message: issue });
    }),
  );
}

export const portfolioNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(60, 'Keep the name under 60 characters');

export const CURRENCIES = ['PLN', 'USD', 'EUR', 'GBP', 'CHF'] as const;

export const transactionInputSchema = z
  .object({
    portfolioId: z.uuid('Pick a portfolio'),
    side: z.enum(['buy', 'sell']),
    symbol: z.string().trim().toUpperCase().min(1, 'Symbol is required').max(20),
    displayName: z.string().trim().min(1, 'Name is required').max(80),
    exchange: z.string().trim().min(1, 'Exchange is required').max(20),
    // Closed list, not a free-text pattern: `instruments` is global,
    // unique-keyed on symbol, and first-write-wins — a typo'd code would bind
    // the symbol permanently, and the NBP FX lookup has no rate for it.
    currency: z.enum(CURRENCIES, { message: 'Unsupported currency' }),
    quantity: decimalString({ positive: true }),
    price: decimalString({ positive: true }),
    fees: z.preprocess(
      (v) => (v == null || v === '' ? '0' : v),
      decimalString({ nonNegative: true }),
    ),
    // Kept as a plain string end-to-end. Round-tripping through Date would
    // shift the day in timezones west of UTC.
    tradeDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format')
      .refine(isValidCalendarDate, 'That date does not exist')
      .refine(isNotFarFuture, 'That date is in the future'),
    fxRateToBase: z.preprocess(normalizeDecimalSeparator, z.string().optional()),
    note: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().trim().max(500).optional(),
    ),
  })
  .superRefine((val, ctx) => {
    // For non-PLN instruments the FX field auto-fills with the NBP mid rate of
    // the last business day strictly before the trade date (the D-1 rule,
    // art. 11a PIT/CIT — see src/lib/fx/), but it stays manual-overridable, so
    // it is validated here exactly like a typed value. For PLN it is forced
    // below, so any stray client-sent value is ignored rather than validated.
    if (val.currency !== 'PLN') {
      const fx = val.fxRateToBase ?? '';
      // fx_rate_to_base is numeric(20,10): 10 integer digits, scale 10.
      const issue = decimalIssue(fx, { positive: true, maxIntegerDigits: 10, maxScale: 10 });
      if (issue) {
        ctx.addIssue({
          code: 'custom',
          path: ['fxRateToBase'],
          message:
            fx === '' ? 'FX rate to PLN is required for a non-PLN currency' : issue,
        });
      }
    }
  })
  .transform((val) => ({
    ...val,
    // PLN is the base currency: the rate is exactly '1' no matter what the
    // client sent. Anything else keeps the validated manual rate.
    fxRateToBase: val.currency === 'PLN' ? '1' : (val.fxRateToBase ?? ''),
  }));

export type TransactionInput = z.output<typeof transactionInputSchema>;

/**
 * Adding a stock to the watchlist mints (or resolves) an instrument exactly
 * like a transaction does, so the instrument fields reuse the EXACT rules of
 * `transactionInputSchema` — same trims, same bounds, same closed currency
 * list (the same first-write-wins rationale: a typo'd code would bind the
 * symbol permanently). No money fields: a watch is pure membership.
 */
export const watchlistAddSchema = z.object({
  symbol: z.string().trim().toUpperCase().min(1, 'Symbol is required').max(20),
  displayName: z.string().trim().min(1, 'Name is required').max(80),
  exchange: z.string().trim().min(1, 'Exchange is required').max(20),
  currency: z.enum(CURRENCIES, { message: 'Unsupported currency' }),
});

export type WatchlistAddInput = z.output<typeof watchlistAddSchema>;

/**
 * A target weight as a percent of one portfolio: a decimal STRING, > 0 and
 * ≤ 100, at most 2 decimal places. The shape is pinned by regex and the
 * bounds compared via `dec()` — no `parseFloat`/`Number()` ever touches it
 * (non-negotiable #1; the value multiplies money downstream). The pl-PL
 * comma is normalized exactly like every other decimal field. Zero is
 * REJECTED deliberately: "no target" is an absent row, and a `0` target
 * would read as a standing order to sell everything.
 */
const TARGET_PCT_RE = /^\d{1,3}(\.\d{1,2})?$/;

export const targetPctSchema = z.preprocess(
  normalizeDecimalSeparator,
  // superRefine with an early return, NOT chained `.regex().refine()`: zod
  // runs every check even after a failed one, and `dec('abc')` THROWS — the
  // regex must gate the Decimal construction, not merely report first.
  z.string().superRefine((v, ctx) => {
    if (!TARGET_PCT_RE.test(v)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Use a percent like 25 or 12,5 (at most 2 decimal places)',
      });
      return;
    }
    const d = dec(v);
    if (!d.greaterThan(0)) {
      ctx.addIssue({ code: 'custom', message: 'Must be greater than zero' });
    }
    if (!d.lessThanOrEqualTo(100)) {
      ctx.addIssue({ code: 'custom', message: 'Keep each target at 100% or less' });
    }
  }),
);

/**
 * The bulk-replace body for one portfolio's targets. `rows` MAY be empty —
 * clearing every target is a legal save, because a blank field is simply
 * omitted by the client (blank ≠ zero, everywhere). Duplicate instruments
 * are refused as a schema rule (the `reorderPortfolios` Set check, moved
 * into the contract): last-write-wins on a duplicate would silently drop a
 * row the user typed.
 */
export const portfolioTargetsPutSchema = z.object({
  rows: z
    .array(
      z.object({
        instrumentId: z.uuid('Invalid instrument'),
        targetPct: targetPctSchema,
      }),
    )
    .max(200, 'Too many targets')
    .refine(
      (rows) => new Set(rows.map((r) => r.instrumentId)).size === rows.length,
      'Each stock can appear only once',
    ),
});

export type PortfolioTargetsPutInput = z.output<typeof portfolioTargetsPutSchema>;

/**
 * OCC-form vendor option ticker, e.g. `O:AAPL260904C00220000` — the `O:`
 * prefix, a root of up to 12 ticker characters (dots for class shares), a
 * six-digit YYMMDD expiry, `C`/`P`, and an eight-digit strike in tenths of a
 * cent. Anchored end to end: nothing URL-shaped, whitespace-shaped or
 * injection-shaped survives it.
 */
export const OCC_TICKER_RE = /^O:[A-Z0-9.]{1,12}\d{6}[CP]\d{8}$/;

/** THE 'YYYY-MM-DD' schema — format AND real-calendar existence. Exported so
 *  every date field (forms, actions, vendor-payload content checks) validates
 *  through one helper instead of re-inventing the regex. */
export const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format')
  .refine(isValidCalendarDate, 'That date does not exist');

/**
 * Adding a tracked option lot. Contract identity (ticker, strike, expiry,
 * type, shares-per-contract) arrives from the server-produced strike list —
 * validation here is shape-level, the defense against a hand-crafted request
 * body rather than against the wizard. Positive bounds throughout: long
 * positions only in v1. Uppercase is REQUIRED, not applied — a lowercase
 * underlying is rejected, never silently normalized (the wizard only ever
 * submits provider notation).
 */
export const optionPositionAddSchema = z.object({
  ticker: z.string().trim().regex(OCC_TICKER_RE, 'Not a valid option ticker'),
  underlying: z
    .string()
    .trim()
    .regex(/^[A-Z0-9.]{1,10}$/, 'Not a valid underlying symbol'),
  contractType: z.enum(['call', 'put']),
  strikePrice: decimalString({ positive: true }),
  sharesPerContract: decimalString({ positive: true }),
  quantity: decimalString({ positive: true }),
  entryPrice: decimalString({ positive: true }),
  expirationDate: dateStringSchema,
  tradeDate: dateStringSchema,
  /** Total lot costs in USD (commission + exchange fee, summed). Optional in
   *  both entry paths — empty defaults to '0', the transaction-fees pattern. */
  fees: z.preprocess(
    (v) => (v == null || v === '' ? '0' : v),
    decimalString({ nonNegative: true }),
  ),
});

export type OptionPositionAddInput = z.output<typeof optionPositionAddSchema>;

/**
 * Editing a tracked option lot — LOT FIELDS ONLY, deliberately. Changing
 * ticker/strike/expiry/type is really a different position (remove and
 * re-add is the path), and keeping identity fields out of this schema is
 * what keeps `updateOptionPosition` from ever writing an unverified contract
 * identity. `strictObject`: an unexpected key is REJECTED, not silently
 * stripped — by schema, not by ignoring it.
 */
export const optionPositionEditSchema = z.strictObject({
  id: z.uuid(),
  quantity: decimalString({ positive: true }),
  entryPrice: decimalString({ positive: true }),
  tradeDate: dateStringSchema,
  fees: z.preprocess(
    (v) => (v == null || v === '' ? '0' : v),
    decimalString({ nonNegative: true }),
  ),
});

export type OptionPositionEditInput = z.output<typeof optionPositionEditSchema>;

/**
 * What the vision extraction returns for a broker's option-position
 * screenshot — one schema serving BOTH as the model's structured-output
 * contract (`zodOutputFormat`) and as the persistence-boundary re-validation
 * of whatever the model produced. Every field nullable: anything not visible
 * in the image is `null`, never a guessed value and never a fake zero.
 * Numbers are STRINGS (dot-decimal after normalization) — they feed
 * `decimalString` validation at add time, never float parsing. Kept free of
 * `preprocess`/`transform` so it converts cleanly to the model's JSON-schema
 * output format.
 */
export const optionScreenshotExtractionSchema = z.object({
  /** Ticker of the underlying if legible, e.g. `SNOW`. */
  underlyingTickerCandidate: z.string().nullable(),
  /** Company name as printed, e.g. `Snowflake Inc.`. */
  companyName: z.string().nullable(),
  contractType: z.enum(['call', 'put']).nullable(),
  /** Dot-decimal string, e.g. `240.00`. */
  strikePrice: z.string().nullable(),
  /** ISO `YYYY-MM-DD`. */
  expirationDate: z.string().nullable(),
  quantity: z.string().nullable(),
  /** Per-share premium paid, dot-decimal. */
  entryPrice: z.string().nullable(),
  /** ISO `YYYY-MM-DD`. */
  tradeDate: z.string().nullable(),
  /** Commission + exchange fee (+ other charges), summed, dot-decimal. */
  fees: z.string().nullable(),
  /** ISO 4217 code if the screenshot shows one beside the costs. */
  feesCurrency: z.string().nullable(),
  /** The broker's raw symbol text, e.g. `SNOW/15F27C240:xcbf`. */
  brokerSymbolText: z.string().nullable(),
});

export type OptionScreenshotExtraction = z.output<typeof optionScreenshotExtractionSchema>;

/**
 * The same contract for a STOCK transaction screenshot (Saxo "Position
 * Details", mBank "szczegóły transakcji", any language). Every field
 * nullable, every number a dot-decimal STRING: nothing here is ever parsed as
 * a float, and an absent value is `null`, never 0.
 *
 * Unlike the option schema, this one is NOT what the model is asked for —
 * nineteen nullable fields exceed the structured-output union limit. The
 * vendor contract is `transactionScreenshotWireSchema` below; this stays the
 * app's own shape, and the persistence-boundary re-validation of whatever
 * came back.
 *
 * Three fields exist purely to stop a value bleeding into a neighbour:
 * `settlementCurrency` (mBank prints `waluta: PLN` beside a USD share price —
 * conflating the two would store złoty in a dollar column),
 * `settlementDate` (`data rozliczenia` is T+1 and must never be read as the
 * trade date), and `totalValue*` (the cross-check that proves which currency
 * the price is quoted in). Kept free of `preprocess`/`transform` so it
 * converts cleanly to the model's JSON-schema output format.
 */
export const transactionScreenshotExtractionSchema = z.object({
  /** Exchange ticker only if legible, e.g. `GOOGL` from `GOOGL:xnas`. */
  tickerCandidate: z.string().nullable(),
  /** Company name exactly as printed, truncation included (`META PLATFOR`). */
  companyName: z.string().nullable(),
  /** 12-character ISIN if shown. DISPLAY ONLY — this app has no ISIN→ticker
   *  source, so it is never used to search for an instrument. */
  isinCandidate: z.string().nullable(),
  exchange: z.string().nullable(),
  /** Only when the screen STATES it; a position screen that does not, is null. */
  side: z.enum(['buy', 'sell']).nullable(),
  /** The verbatim word that decided `side` (`kupno`), so the UI can say why. */
  sideEvidence: z.string().nullable(),
  /** Number of shares. */
  quantity: z.string().nullable(),
  /** Per-share price (`kurs`, or the figure after `@`). */
  pricePerShare: z.string().nullable(),
  /** The currency `pricePerShare` is quoted in — from the instrument header
   *  (`NASDAQ USD`), NEVER from an account/settlement label. */
  priceCurrency: z.string().nullable(),
  /** The account/settlement currency (`waluta: PLN`). */
  settlementCurrency: z.string().nullable(),
  /** `wartość` / `Market Value` — the currency cross-check's input. */
  totalValue: z.string().nullable(),
  totalValueCurrency: z.string().nullable(),
  /** Commission + exchange fee, summed. */
  fees: z.string().nullable(),
  feesCurrency: z.string().nullable(),
  /** `kurs przewalutowania` / `Conversion USD>PLN`, as PLN per foreign unit. */
  brokerFxRate: z.string().nullable(),
  /** The EXECUTION date, ISO `YYYY-MM-DD`. */
  tradeDate: z.string().nullable(),
  /** The settlement/value date — extracted so the model has somewhere to put
   *  it instead of bleeding it into `tradeDate`. Never used downstream. */
  settlementDate: z.string().nullable(),
  screenKind: z.enum(['transaction', 'position']).nullable(),
  /** The broker's raw symbol string, verbatim. */
  brokerSymbolText: z.string().nullable(),
});

export type TransactionScreenshotExtraction = z.output<
  typeof transactionScreenshotExtractionSchema
>;

/**
 * The SAME nineteen fields, in the shape the model is actually asked for.
 *
 * Structured outputs refuse a schema with more than SIXTEEN union-typed
 * parameters ("exponential compilation cost"), and `.nullable()` compiles to
 * `anyOf: [string, null]` — one union per field. Nineteen nullable fields
 * therefore made EVERY transaction import fail with a 400 before the image
 * was ever looked at (the option schema has eleven, which is why that import
 * kept working). Absence is carried by the empty string here instead, so the
 * wire schema has ZERO unions and the limit stops being something a new field
 * can silently walk into.
 *
 * This exists ONLY as the vendor contract. Nothing downstream sees it:
 * `transactionExtractionFromWire` turns it straight back into the nullable
 * `TransactionScreenshotExtraction` that the normalizer, the prefill layer
 * and the persistence-boundary re-validation have always consumed. `''` is a
 * transport convention, never a value — it must never reach a form field.
 */
export const transactionScreenshotWireSchema = z.object({
  tickerCandidate: z.string(),
  companyName: z.string(),
  isinCandidate: z.string(),
  exchange: z.string(),
  /** `''` when the screen never states buy or sell — an enum member, not a
   *  union, so it costs nothing against the limit. */
  side: z.enum(['buy', 'sell', '']),
  sideEvidence: z.string(),
  quantity: z.string(),
  pricePerShare: z.string(),
  priceCurrency: z.string(),
  settlementCurrency: z.string(),
  totalValue: z.string(),
  totalValueCurrency: z.string(),
  fees: z.string(),
  feesCurrency: z.string(),
  brokerFxRate: z.string(),
  tradeDate: z.string(),
  settlementDate: z.string(),
  screenKind: z.enum(['transaction', 'position', '']),
  brokerSymbolText: z.string(),
});

export type TransactionScreenshotWire = z.output<typeof transactionScreenshotWireSchema>;

/**
 * Wire → domain: `''` becomes `null` for every field, including the two
 * enums. Whitespace-only counts as absent, because a model that has nothing
 * to say sometimes says `' '`; every other value passes through untouched for
 * the normalizer to judge.
 */
export function transactionExtractionFromWire(
  wire: TransactionScreenshotWire,
): TransactionScreenshotExtraction {
  const text = (value: string): string | null => (value.trim() === '' ? null : value);

  return {
    tickerCandidate: text(wire.tickerCandidate),
    companyName: text(wire.companyName),
    isinCandidate: text(wire.isinCandidate),
    exchange: text(wire.exchange),
    side: wire.side === '' ? null : wire.side,
    sideEvidence: text(wire.sideEvidence),
    quantity: text(wire.quantity),
    pricePerShare: text(wire.pricePerShare),
    priceCurrency: text(wire.priceCurrency),
    settlementCurrency: text(wire.settlementCurrency),
    totalValue: text(wire.totalValue),
    totalValueCurrency: text(wire.totalValueCurrency),
    fees: text(wire.fees),
    feesCurrency: text(wire.feesCurrency),
    brokerFxRate: text(wire.brokerFxRate),
    tradeDate: text(wire.tradeDate),
    settlementDate: text(wire.settlementDate),
    screenKind: wire.screenKind === '' ? null : wire.screenKind,
    brokerSymbolText: text(wire.brokerSymbolText),
  };
}

/**
 * Calendar validity for an already regex-matched 'YYYY-MM-DD' string. Pure
 * string/integer math — no Date round-trip (which would shift the day west of
 * UTC), and these are calendar integers, not money, so parseInt is correct.
 * Without this, '2026-02-31' reaches Postgres and throws 22008 as an
 * uncaught 500 instead of a field error.
 *
 * Exported: the FX lookup (Server Action input + the form's fetch trigger)
 * guards trade dates with the exact same regex + calendar pair.
 */
/**
 * The ONE forward bound on a trade date (bug audit 2026-08-19, minor 3).
 *
 * A trade cannot have happened tomorrow, but nothing rejected one: a date
 * typo'd as `2035-01-15` was stored, and analytics then dated the terminal
 * XIRR valuation nine years out and discounted today's value over fifteen
 * years instead of six — the rate silently fell from ~7 %/yr to ~2.7 %/yr and
 * stayed wrong until the row was edited.
 *
 * **The window is deliberately one day, and it is not slack.** The form's
 * date input is the BROWSER's calendar (Warsaw), while `nyDateISOAt` is New
 * York's — and Warsaw runs ahead, by at most one calendar day (Warsaw 00:30
 * is still the previous afternoon in New York). One day forward therefore
 * accepts every date a person in Warsaw can legitimately pick today, and
 * rejects the typo. `TransactionInput.swift` ports this rule for rule and
 * needs the same bound; the mobile API contract shares this schema, so a
 * tighter window would reject a legitimate entry from either client.
 */
function isNotFarFuture(value: string): boolean {
  // Evaluated per call, never memoized at module load: this module lives for
  // the life of the server process and a cached "today" would start rejecting
  // valid dates at the first midnight.
  return value <= addOneDay(nyDateISOAt(Date.now()));
}

/** 'YYYY-MM-DD' + 1 day, by string arithmetic — never through `Date`. */
function addOneDay(dateISO: string): string {
  const year = parseInt(dateISO.slice(0, 4), 10);
  const month = parseInt(dateISO.slice(5, 7), 10);
  const day = parseInt(dateISO.slice(8, 10), 10);
  // A date, not money: `Date.UTC` is the timezone-free calendar the rest of
  // this file's date helpers already use, and it never touches a price.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

export function isValidCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-');
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}
