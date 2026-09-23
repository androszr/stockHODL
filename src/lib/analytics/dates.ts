import type Decimal from 'decimal.js';

import { dec } from '@/lib/money';

/**
 * Plain 'YYYY-MM-DD' date arithmetic for the analytics layer — pure and
 * isomorphic, no `server-only`, no `Date`.
 *
 * Two rules from the plan meet here:
 *
 * 1. **Never round-trip a trade date through `Date`.** Every date in this
 *    feature is a plain 'YYYY-MM-DD' string; a `Date` would introduce a
 *    timezone the string never had, and "today in New York" already comes
 *    from `nyDateISOAt` upstream.
 * 2. **No float coercion, no float parsing and no `Math` helpers** anywhere
 *    under `src/lib/analytics/` — the acceptance criteria grep for the exact
 *    identifiers, so they appear nowhere in this directory — comments and
 *    tests included. Even the day counting therefore runs on Decimal. It
 *    costs nothing (a few hundred dates per page load) and it means there is
 *    no float anywhere in the return math, not even in the exponent's
 *    denominator.
 *
 * The conversion is Howard Hinnant's civil-date algorithm, transcribed into
 * Decimal: exact integer arithmetic, valid for every date this app can hold.
 */

/** Days from the Unix epoch (1970-01-01 → 0) for a 'YYYY-MM-DD' string. */
export function epochDay(dateISO: string): Decimal {
  const y0 = dec(dateISO.slice(0, 4));
  const m = dec(dateISO.slice(5, 7));
  const d = dec(dateISO.slice(8, 10));

  // March-based year: February's leap day becomes the LAST day of the year,
  // which is what removes every special case below.
  const y = m.lessThanOrEqualTo(2) ? y0.minus(1) : y0;
  const era = y.div(400).floor();
  const yoe = y.minus(era.times(400)); // [0, 399]
  const mp = m.greaterThan(2) ? m.minus(3) : m.plus(9); // [0, 11]
  const doy = dec(153).times(mp).plus(2).div(5).floor().plus(d).minus(1); // [0, 365]
  const doe = yoe
    .times(365)
    .plus(yoe.div(4).floor())
    .minus(yoe.div(100).floor())
    .plus(doy); // [0, 146096]

  return era.times(146097).plus(doe).minus(719468);
}

/** Whole days from `fromISO` to `toISO`; negative when `toISO` is earlier. */
export function daysBetween(fromISO: string, toISO: string): Decimal {
  return epochDay(toISO).minus(epochDay(fromISO));
}

const MS_PER_DAY = '86400000';

/**
 * `dateISO` shifted by whole days, still a plain 'YYYY-MM-DD'. The only way
 * this feature moves a date — never a `Date`, never a millisecond offset.
 */
export function addDaysISO(dateISO: string, days: number): string {
  return isoFromEpochDay(epochDay(dateISO).plus(days));
}

/** Zero-padded fixed-width integer string — the ISO date's only formatting. */
function pad(value: Decimal, width: number): string {
  return value.toFixed(0).padStart(width, '0');
}

/** The inverse of `epochDay`: day number → 'YYYY-MM-DD'. */
export function isoFromEpochDay(days: Decimal): string {
  const z = days.plus(719468);
  const era = z.div(146097).floor();
  const doe = z.minus(era.times(146097)); // [0, 146096]
  const yoe = doe
    .minus(doe.div(1460).floor())
    .plus(doe.div(36524).floor())
    .minus(doe.div(146096).floor())
    .div(365)
    .floor(); // [0, 399]
  const y = yoe.plus(era.times(400));
  const doy = doe.minus(
    dec(365).times(yoe).plus(yoe.div(4).floor()).minus(yoe.div(100).floor()),
  ); // [0, 365]
  const mp = dec(5).times(doy).plus(2).div(153).floor(); // [0, 11]
  const d = doy.minus(dec(153).times(mp).plus(2).div(5).floor()).plus(1); // [1, 31]
  const m = mp.lessThan(10) ? mp.plus(3) : mp.minus(9); // [1, 12]

  return `${pad(m.lessThanOrEqualTo(2) ? y.plus(1) : y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/**
 * Epoch milliseconds (a `ChartPoint.t`, always midnight UTC on a daily
 * series) → 'YYYY-MM-DD'. `floor` rather than a round trip through `Date`, so
 * the string is derived by the same arithmetic that produced it.
 */
export function isoFromEpochMs(tMs: number): string {
  return isoFromEpochDay(dec(tMs).div(MS_PER_DAY).floor());
}
