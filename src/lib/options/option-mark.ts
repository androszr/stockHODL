import { nyDateISOAt } from '@/lib/market-data/market-clock';
import type { OptionQuote, OptionQuoteOutcome } from '@/lib/market-data/options-types';
import { dec } from '@/lib/money';

import { bsMark } from './black-scholes';
import { utcNoonMs } from './ny-dates';

/**
 * THE MARK BOUNDARY — the load-bearing rule of the model-pricing plan, written
 * where it is enforced:
 *
 * > **The mark boundary.** A model mark is a NUMERICAL ESTIMATE, not money
 * > arithmetic. The numerical core (`black-scholes.ts`) may use JS numbers
 * > internally. It crosses to and from decimal strings in exactly ONE file,
 * > this one, and its output crosses back through `dec()` exactly once — the
 * > same sanctioned shape as `decString()` in `massive-mapping.ts`. A mark
 * > never touches cost basis, quantity, fees, FX or any stored money column:
 * > those stay Decimal end-to-end, and the mark enters them only as a
 * > `numeric`-shaped decimal string like any vendor price.
 *
 * This is therefore the ONLY file under `src/lib/options` allowed to contain
 * `toNumber(` (grep-asserted in the plan's acceptance criteria). Everything
 * downstream — the resolver, the payload, the P/L, the totals, the recorded
 * row — sees an ordinary decimal string and does ordinary Decimal math.
 *
 * DAY COUNT: `T = (utcNoon(expiry) − utcNoon(NY today)) / 86_400_000 / 365` —
 * ACT/365 fixed on NY CALENDAR DATES, through the app's existing DST-immune
 * `utcNoonMs` idiom. Chosen because (a) an annualized IV surface is
 * conventionally quoted against it, (b) it needs no trading calendar, so a
 * holiday cannot silently move a price, and (c) any residual convention error
 * is largely absorbed by the per-contract rate recovery, which is fit at this
 * same `T`. Never the device timezone.
 *
 * FAIL CLOSED, ALWAYS: every gate below returns null — a silent, per-contract
 * fallback to today's traded-price behaviour, with no throw and no log spam.
 * A nonsense mark is worse than a stale trade.
 */

const DAYS_PER_YEAR = 365;
const MS_PER_DAY = 86_400_000;

/** Absolute slack on the intrinsic-value floor — float noise, not money. */
const INTRINSIC_EPSILON = 1e-9;

/**
 * One model mark plus the inputs it was produced from. The inputs travel with
 * the mark so a recorded row can be AUDITED later: a number nobody can
 * reconstruct is not an honest record. Every field is a decimal string.
 */
export interface OptionMarkRecord {
  ticker: string;
  /** The model mark, per share — a `numeric`-shaped decimal string. */
  mark: string;
  underlyingPrice: string;
  impliedVolatility: string;
  delta: string;
  /** The recovered carry rate, as a fraction (0.0209 = 2.09%). */
  rate: string;
}

/** Case-tolerant spot lookup — vendor tickers come back uppercase. */
function lookupSpot(
  spots: ReadonlyMap<string, string>,
  underlying: string | null,
): string | undefined {
  if (underlying === null) return undefined;
  return spots.get(underlying) ?? spots.get(underlying.toUpperCase());
}

/**
 * One contract → one mark record, or null. The gates, in order (all of them
 * are fallbacks, never clamps):
 *
 * 1. `impliedVolatility` present and `> 0` — thin contracts omit it entirely.
 * 2. `greeks.delta` present and strictly inside `(0,1)` for a call /
 *    `(−1,0)` for a put; a delta at the bound makes the rate recovery
 *    unsolvable.
 * 3. `T > 0` — the expiry is strictly after the NY calendar date. At `T → 0`
 *    the model degenerates and intrinsic value is the only honest answer.
 * 4. A spot for the underlying arrived in this batch and is `> 0`.
 * 5. Strike `> 0`.
 * 6. The rate bisection CONVERGED (inside `black-scholes.ts`).
 * 7. The plausibility guard: finite and `> 0`; at or above intrinsic value
 *    (a mark below intrinsic is arbitrage-free nonsense and the likeliest
 *    symptom of a bad input); and within the standard upper bound — `S` for
 *    a call, `K` for a put.
 */
export function markOptionRecord(
  quote: OptionQuote,
  spot: string | undefined,
  nowMs: number,
): OptionMarkRecord | null {
  const ivRaw = quote.impliedVolatility;
  const deltaRaw = quote.greeks.delta;
  if (ivRaw === null || deltaRaw === null || spot === undefined) return null;

  // ---- The crossing IN: decimal strings become plain numbers, here and
  // nowhere else under src/lib/options.
  const sigma = dec(ivRaw).toNumber();
  const delta = dec(deltaRaw).toNumber();
  const S = dec(spot).toNumber();
  const K = dec(quote.strikePrice).toNumber();

  if (!(sigma > 0) || !(S > 0) || !(K > 0)) return null;

  const isCall = quote.contractType === 'call';
  if (isCall ? !(delta > 0 && delta < 1) : !(delta > -1 && delta < 0)) return null;

  // ACT/365 on NY calendar dates — an expired or same-day contract has no
  // time value left to model.
  const todayISO = nyDateISOAt(nowMs);
  const T = (utcNoonMs(quote.expirationDate) - utcNoonMs(todayISO)) / MS_PER_DAY / DAYS_PER_YEAR;
  if (!(T > 0)) return null;

  const result = bsMark({ type: isCall ? 'call' : 'put', S, K, T, sigma, delta });
  if (result === null) return null;

  const { mark, rate } = result;
  if (!Number.isFinite(mark) || !(mark > 0) || !Number.isFinite(rate)) return null;

  // Plausibility: intrinsic floor and the standard upper bound.
  const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  if (mark < intrinsic - INTRINSIC_EPSILON) return null;
  if (isCall ? mark > S : mark > K) return null;

  // ---- The crossing OUT: one `dec()` per figure, decimal strings from here
  // on. `dec(number)` is the same sanctioned shape as `decString()`.
  return {
    ticker: quote.ticker,
    mark: dec(mark).toString(),
    underlyingPrice: dec(spot).toString(),
    impliedVolatility: dec(ivRaw).toString(),
    delta: dec(deltaRaw).toString(),
    rate: dec(rate).toString(),
  };
}

/** The mark alone, as a decimal string — the resolver's input shape. */
export function markOption(
  quote: OptionQuote,
  spot: string | undefined,
  nowMs: number,
): string | null {
  return markOptionRecord(quote, spot, nowMs)?.mark ?? null;
}

/**
 * Every markable contract in a batch → its audit record. Failed outcomes and
 * every rejected gate are simply absent: an absent mark IS the fallback
 * signal, and the resolver reads it as "price this one exactly as before".
 */
export function markOptionRecords(
  quotes: ReadonlyMap<string, OptionQuoteOutcome>,
  spots: ReadonlyMap<string, string>,
  nowMs: number,
  /**
   * ticker → the underlying WE stored when the lot was added. When supplied,
   * a contract whose vendor-reported underlying disagrees with ours is not
   * marked at all (security review, 2026-08-15): the spot is otherwise chosen
   * purely on the vendor's say-so, and a mislabelled contract would be priced
   * off a different company's share price and then PERMANENTLY recorded. The
   * two symbols would both have to be the user's own holdings for it to bite,
   * which is why this is a fallback rather than an alarm — but a mark we
   * cannot stand behind must not be written.
   */
  expectedUnderlyings: ReadonlyMap<string, string> = new Map(),
): Map<string, OptionMarkRecord> {
  const records = new Map<string, OptionMarkRecord>();
  for (const [ticker, outcome] of quotes) {
    if (!outcome.ok) continue;

    const expected = expectedUnderlyings.get(ticker);
    const reported = outcome.quote.underlying;
    if (
      expected !== undefined &&
      reported !== null &&
      expected.toUpperCase() !== reported.toUpperCase()
    ) {
      continue; // disagreement → no mark, fall back to the traded price
    }

    const record = markOptionRecord(outcome.quote, lookupSpot(spots, reported), nowMs);
    if (record !== null) records.set(ticker, record);
  }
  return records;
}

/** The payload path's view: ticker → mark decimal string. */
export function markOptionQuotes(
  quotes: ReadonlyMap<string, OptionQuoteOutcome>,
  spots: ReadonlyMap<string, string>,
  nowMs: number,
): Map<string, string> {
  const marks = new Map<string, string>();
  for (const [ticker, record] of markOptionRecords(quotes, spots, nowMs)) {
    marks.set(ticker, record.mark);
  }
  return marks;
}
