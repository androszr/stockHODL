import type Decimal from 'decimal.js';

import { dec, ZERO } from '@/lib/money';

import { daysBetween } from './dates';

/**
 * Money-weighted return (XIRR) — pure, isomorphic, and **entirely inside
 * decimal.js**. There is no float exit in this module, and none is needed.
 *
 * The design decision, stated because it is the one place a naive
 * implementation reaches for floats:
 *
 * - **The discounting kernel is `amount / (1 + r)^(days/365)`**, and
 *   `Decimal.prototype.pow` supports NON-INTEGER exponents (decimal.js
 *   10.6.0, at the `precision: 34` this repo sets in `money.ts`). That is
 *   what removes the need for a floating-point power function, and it is why
 *   this module requests no exception to non-negotiable #1 and takes none.
 * - **The root finder is bisection, not Newton.** Bisection needs only
 *   comparison, addition and halving — all exact in Decimal — and cannot
 *   diverge. Newton would need a derivative and a divergence guard for no
 *   benefit at this scale (a few hundred flows, once per page load).
 * - **The bracket floor is `-0.9999`, never `-1` or below**: `(1 + r)` must
 *   stay strictly positive or a non-integer `pow` is undefined and decimal.js
 *   throws. The ceiling is `100` (+10 000 %/yr).
 *
 * Every refusal is NAMED. The UI renders "—" with the reason in words; it
 * never renders a fabricated rate, and this function never throws.
 */

export interface CashFlow {
  /** Plain 'YYYY-MM-DD' — never round-tripped through `Date`. */
  dateISO: string;
  /** Signed PLN: NEGATIVE for money out (buys), POSITIVE for money in. */
  amountPLN: Decimal;
}

export type XirrRefusal =
  /** Nothing to solve. */
  | 'no_flows'
  /**
   * Every non-zero flow points the same way — all buys with nothing sold or
   * valued, or all sells. A wiped-out position (terminal value exactly zero)
   * lands here too: with no positive flow at all there is nothing for a rate
   * to balance against, and the refusal is caught one gate before the bracket
   * check would see it.
   */
  | 'no_sign_change'
  /** No rate in [-99.99 %, +10 000 %] makes the flows balance. */
  | 'no_bracket'
  /** Under 30 days: an annualized rate over three weeks is arithmetic, not information. */
  | 'too_short';

export type XirrResult = { ok: true; rate: Decimal } | { ok: false; reason: XirrRefusal };

/** Under this span an annualized figure says more about the calendar than the portfolio. */
export const MIN_SPAN_DAYS = 30;

/** A safety net, not the accuracy limit — see `TOLERANCE`. */
export const MAX_ITERATIONS = 200;

/**
 * Bracket width at which the bisection stops. The plan named `1e-12` as the
 * floor; this is tighter on purpose, because the acceptance criterion is that
 * `npv(rate)` round-trips to within `1e-10` of zero — and NPV's slope against
 * `r` is a few thousand at portfolio scale, so a `1e-12` rate error would
 * leave a `1e-9` residual. Reaching `1e-20` costs ~73 halvings of the 200
 * budget, so the iteration cap remains a safety net rather than the accuracy
 * limit, exactly as the plan intends.
 */
const TOLERANCE = '1e-20';

const LO = '-0.9999';
const HI = '100';
const DAYS_PER_YEAR = '365';

/** A flow reduced to its integer day offset from the earliest flow. */
interface DatedFlow {
  days: Decimal;
  amountPLN: Decimal;
}

function toDated(flows: readonly CashFlow[]): DatedFlow[] {
  if (flows.length === 0) return [];
  const anchor = flows.reduce((min, f) => (f.dateISO < min ? f.dateISO : min), flows[0].dateISO);
  return flows.map((f) => ({
    days: daysBetween(anchor, f.dateISO),
    amountPLN: f.amountPLN,
  }));
}

/**
 * The discounting kernel, in the ONE arrangement that keeps it affordable.
 *
 * The obvious form — `amount / (1 + r)^(days/365)` — costs a NON-INTEGER
 * `Decimal.pow` per flow per bisection step, i.e. a natural log and an
 * exponential at 34 digits, hundreds of times over. Factoring it as
 *
 *     dayFactor = (1 + r)^(1/365)     // one non-integer pow per rate
 *     discount  = dayFactor^days      // integer exponent -> repeated squaring
 *
 * is the same number and roughly two orders of magnitude cheaper: an integer
 * exponent takes decimal.js's fast path (~12 multiplications for a decade of
 * days). The precision cost is bounded and tiny — raising a 34-digit value to
 * the ~4 000th power spends about 3.6 of those digits, leaving far more than
 * the `1e-10` the round-trip assertion needs.
 *
 * `(1 + r)` is strictly positive for every rate inside the bracket, which is
 * what guarantees this can never throw a DecimalError.
 */
function npvOf(entries: readonly DatedFlow[], rate: Decimal): Decimal {
  const dayFactor = dec(1).plus(rate).pow(dec(1).div(DAYS_PER_YEAR));
  let total = ZERO;
  for (const entry of entries) {
    total = total.plus(entry.amountPLN.div(dayFactor.pow(entry.days)));
  }
  return total;
}

/**
 * Net present value of `flows` at annual rate `rate`, discounted from the
 * EARLIEST flow date. Exported for the round-trip test: the honest assertion
 * about a root finder is that its answer zeroes the function it solved.
 */
export function npv(flows: readonly CashFlow[], rate: Decimal): Decimal {
  if (flows.length === 0) return ZERO;
  return npvOf(toDated(flows), rate);
}

/**
 * Optional instrumentation for tests: `evaluations` is incremented once per
 * NPV evaluation the solver performs. It lets a test prove the bisection's
 * work is bounded by `MAX_ITERATIONS` by COUNTING, instead of inferring it
 * from how long a large input took on a machine of unknown load. Production
 * never passes one.
 */
export interface XirrProbe {
  evaluations: number;
}

export function xirr(flows: readonly CashFlow[], probe?: XirrProbe): XirrResult {
  if (flows.length === 0) return { ok: false, reason: 'no_flows' };

  const dates = flows.map((f) => f.dateISO);
  const first = dates.reduce((min, d) => (d < min ? d : min));
  const last = dates.reduce((max, d) => (d > max ? d : max));
  if (daysBetween(first, last).lessThan(MIN_SPAN_DAYS)) {
    return { ok: false, reason: 'too_short' };
  }

  const hasPositive = flows.some((f) => f.amountPLN.greaterThan(0));
  const hasNegative = flows.some((f) => f.amountPLN.lessThan(0));
  if (!hasPositive || !hasNegative) return { ok: false, reason: 'no_sign_change' };

  const entries = toDated(flows);
  const evaluate = (rate: Decimal): Decimal => {
    if (probe) probe.evaluations += 1;
    return npvOf(entries, rate);
  };
  let lo = dec(LO);
  let hi = dec(HI);
  const npvLo = evaluate(lo);
  const npvHi = evaluate(hi);
  // An absurd return (past +10 000 %/yr, or below -99.99 %/yr) lands here and
  // renders "—" rather than a number nobody can defend. A total wipeout was
  // already refused above as `no_sign_change`: with a zero terminal value the
  // flows carry no positive side at all.
  if (npvLo.isZero()) return { ok: true, rate: lo };
  if (npvHi.isZero()) return { ok: true, rate: hi };
  if (npvLo.isPositive() === npvHi.isPositive()) return { ok: false, reason: 'no_bracket' };

  const loWasPositive = npvLo.isPositive();
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (hi.minus(lo).lessThan(TOLERANCE)) break;
    const mid = lo.plus(hi).div(2);
    const value = evaluate(mid);
    if (value.isZero()) return { ok: true, rate: mid };
    if (value.isPositive() === loWasPositive) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { ok: true, rate: lo.plus(hi).div(2) };
}
