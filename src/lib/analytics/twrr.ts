import type Decimal from 'decimal.js';

import { dec, ZERO } from '@/lib/money';

import { daysBetween } from './dates';
import { MIN_SPAN_DAYS } from './xirr';

/**
 * Time-weighted return — pure, isomorphic, Decimal end to end.
 *
 * TWRR is the figure that answers "how did my PICKS do", independent of when
 * money went in: each day's sub-period return is measured against the value
 * the portfolio actually started that day with, and the days are chain-linked.
 * A deposit on a flat day therefore reads ~0 %, where XIRR would not.
 *
 * **Convention, stated here and repeated in the UI caption: flows are treated
 * as occurring at the START of the day.** So the day's return is
 *
 *     r_d = value_d / (value_{d-1} + flow_d) - 1
 *
 * A day whose denominator is zero or within a hair of it is SKIPPED and
 * COUNTED into `skippedDays` — never linked as 0 %, which would silently
 * claim a flat day about a day nothing can be said about. The count is
 * disclosed on screen.
 *
 * **The zero-value day, and why it is not just another link (bug audit,
 * 2026-08-18).** A full liquidation produces a day whose ENDING value is
 * exactly zero while the start-of-day denominator is still positive, so the
 * naive chain multiplies by `0 / denominator = 0` and pins the whole result
 * at −100 % forever — a total loss reported about a portfolio that went to
 * cash and came back up. Two rules prevent that:
 *
 * 1. **A liquidation is measured at the END of the day**, GROSS on both
 *    sides (bug audit 2026-08-19, major 1). The day's ending wealth is the
 *    sale proceeds and the day's starting capital is yesterday's value plus
 *    whatever was put in that morning:
 *
 *        r_d = (value_d + outflow_d) / (value_{d−1} + inflow_d) − 1
 *
 *    The first version of this branch used the day's NET flow as the
 *    proceeds and yesterday's value alone as the denominator, which is right
 *    only when nothing was bought that day. Double down in the morning and
 *    exit in the afternoon — 1 000 held, 10 000 bought, the lot sold for
 *    12 100 — and the net is −2 100, giving `(0 + 2 100) / 1 000 = +110 %`
 *    for a day that actually returned `12 100 / 11 000 = +10 %`. An 11×
 *    error, entirely plausible on screen, and a permanent multiplier on
 *    everything after it. Gross figures are what make the day measurable at
 *    all, and they come straight out of the transaction stream.
 * 2. **Every other empty day BREAKS the chain.** Sitting in cash says nothing
 *    about how the picks did: the day is skipped, counted and disclosed, and
 *    the chain restarts on the next day the portfolio holds something (whose
 *    denominator is then the money put back in).
 *
 * **A PARTIAL day never takes the liquidation path**, whatever its flows say.
 * A day the series could not price in full reads as an empty portfolio while
 * the money is merely unvalued: sell everything and buy an instrument with no
 * bar yet and the day looks like a liquidation that lost most of its capital.
 * There is no honest figure for such a day, so it breaks the chain and is
 * counted — the same answer this module gives every other time it cannot see
 * what happened.
 */

export interface TwrrDay {
  /** Plain 'YYYY-MM-DD'. */
  dateISO: string;
  /** Portfolio market value in PLN at the END of this day. */
  valuePLN: Decimal;
  /**
   * External money INTO the portfolio this day (purchases), a non-negative
   * magnitude — the portfolio's perspective, the negation of the investor
   * cash flow XIRR uses. See `DayFlow` in `cash-flows.ts` for why the two
   * directions are carried separately instead of netted.
   */
  inflowPLN: Decimal;
  /** External money OUT of the portfolio this day (sale proceeds), >= 0. */
  outflowPLN: Decimal;
  /**
   * The series could not price every holding on this day. A partial day's
   * value is not a valuation, so it is never measured as a liquidation.
   */
  partial?: boolean;
}

export interface TwrrResult {
  /** Chain-linked return over the whole span, as a PERCENT (not a ratio). */
  cumulative: Decimal;
  /** Annualized percent; null under `MIN_SPAN_DAYS` — the XIRR `too_short` rule. */
  annualized: Decimal | null;
  /**
   * Days the chain could say nothing about — an empty portfolio, or a
   * denominator at or below zero. Excluded from the chain, counted here and
   * disclosed on screen; the chain restarts on the next day with value.
   */
  skippedDays: number;
  /** Days received — the count the caller asserts against its undownsampled series. */
  days: number;
}

const DAYS_PER_YEAR = '365';
const HUNDRED = '100';

/**
 * A value at or under a millionth of a złoty is nothing held. The tolerance
 * exists because a denominator of `1e-9` left over from a rounding tail would
 * otherwise divide a whole day's value by dust and manufacture a return in
 * the millions of percent.
 */
const NEAR_ZERO = '0.000001';

export function twrr(days: readonly TwrrDay[]): TwrrResult {
  if (days.length < 2) {
    return { cumulative: ZERO, annualized: null, skippedDays: 0, days: days.length };
  }

  const tolerance = dec(NEAR_ZERO);
  let factor = dec(1);
  let skippedDays = 0;
  let previous = days[0];

  for (let i = 1; i < days.length; i++) {
    const day = days[i];

    // Start-of-day capital, GROSS: yesterday's value plus what went in this
    // morning. This is the liquidation denominator, and netting the outflow
    // into it is exactly the +110 % bug described on the module.
    const startCapital = previous.valuePLN.plus(day.inflowPLN);

    if (day.valuePLN.lessThanOrEqualTo(tolerance)) {
      // The day ended holding NOTHING. Linking `0 / denominator` here is the
      // bug this branch exists to prevent: it zeroes the entire chain and
      // never recovers, so a sell-everything-and-rebuy round trip reports
      // −100 % on a portfolio that made money.
      const liquidated =
        day.partial !== true &&
        startCapital.greaterThan(tolerance) &&
        day.outflowPLN.greaterThan(tolerance);
      if (liquidated) {
        // Rule 1: the outflow IS the sale's proceeds — the day's ending
        // wealth — measured against the capital the day started with, so the
        // sale's own gain or loss stays in the chain.
        factor = factor.times(day.valuePLN.plus(day.outflowPLN).div(startCapital));
      } else {
        // Rule 2: cash — or a day nothing can be valued on — says nothing
        // about the picks. Skip, count, disclose; the chain restarts here.
        skippedDays++;
      }
      previous = day;
      continue;
    }

    // An ordinary day is unchanged: flows at the START of the day, netted,
    // because a day that ends holding something has a real ending value to
    // divide by that denominator.
    const denominator = startCapital.minus(day.outflowPLN);
    if (denominator.greaterThan(tolerance)) {
      factor = factor.times(day.valuePLN.div(denominator));
    } else {
      // Nothing was held (or the flow overshot the value): there is no
      // sub-period return to state. Counted, never linked as zero.
      skippedDays++;
    }
    previous = day;
  }

  const elapsed = daysBetween(days[0].dateISO, days[days.length - 1].dateISO);
  const annualized =
    elapsed.lessThan(MIN_SPAN_DAYS) || !factor.greaterThan(0)
      ? null
      : // Non-integer exponent on a strictly positive base: every link above
        // is a ratio of positive numbers, so `factor` stays positive — the
        // guard is a belt on top of that, never a live branch.
        factor.pow(dec(DAYS_PER_YEAR).div(elapsed)).minus(1).times(HUNDRED);

  return {
    cumulative: factor.minus(1).times(HUNDRED),
    annualized,
    skippedDays,
    days: days.length,
  };
}
