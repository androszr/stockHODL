/**
 * The Black-Scholes NUMERICAL CORE — `number` in, `number` out, isomorphic,
 * I/O-free, and deliberately ignorant of decimal strings: this file imports
 * NOTHING from the money module and never sees a money string (both
 * grep-asserted in the plan's acceptance criteria). Every crossing between
 * this arithmetic and
 * the app's Decimal money discipline happens in exactly one place,
 * `option-mark.ts`, which quotes the rule it enforces.
 *
 * Why floats at all: `exp`, `log` and `erf` are genuinely floating-point
 * mathematics and `decimal.js` does not provide them. A model mark is a
 * NUMERICAL ESTIMATE, not money arithmetic — it never meets a cost basis, a
 * quantity or a fee as a float.
 *
 * The method, measured live 2026-08-15 against our own key and a reference
 * quote source (do NOT re-derive — these are ground truth):
 *
 * | contract                 | IV        | delta    | recovered r | mark  | reference          |
 * |--------------------------|-----------|----------|-------------|-------|--------------------|
 * | `O:ACME270319C00260000`  | 0.4570919 | 0.277724 |  +2.09%     |  9.99 | reference mid 9.97 |
 * | `O:ZORA270319C00095000`  | 0.4118177 | 0.260033 |  −0.22%     |  3.16 | reference mid 3.27 |
 * | `O:IDXF261218C00700000`  | 0.2174138 | 0.825814 |  +2.25%     | 91.54 | last trade 92.73   |
 *
 * The carry rate `r` is RECOVERED per contract rather than hardcoded: bisect
 * `r` until the model's `N(d1)` equals the vendor's OWN delta, which makes the
 * price self-consistent with their surface instead of depending on a guess.
 * A naive `r = 4%` prices ACME at 10.50 and `r = 0%` at 9.45 — both ~0.5 out
 * against the recovered fit's +0.02. Recovering `r` also absorbs dividend
 * yield and most of any day-count convention error, because `r` is fit at the
 * same `T` the price is then evaluated at. Do not "simplify" it away.
 *
 * The model is European while the contracts are American: accepted
 * deliberately (we reproduce the VENDOR'S surface — their IV, their delta —
 * rather than pricing independently), and the output is labelled an estimate
 * everywhere it renders. The intrinsic-value floor in `option-mark.ts` catches
 * the deep-ITM put case where a European model deviates most.
 */

export type OptionType = 'call' | 'put';

export interface BsInput {
  type: OptionType;
  /** Spot price of the underlying. */
  S: number;
  /** Strike. */
  K: number;
  /** Time to expiry in years (ACT/365 on NY calendar dates). */
  T: number;
  /** Annualized implied volatility as a fraction (0.45 = 45%). */
  sigma: number;
  /** Continuously compounded carry rate — recovered, never assumed. */
  r: number;
}

/** Abramowitz & Stegun 26.2.17 constants (|ε| < 7.5e-8). */
const A_S_P = 0.2316419;
const A_S_B = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
const INV_SQRT_2PI = 0.3989422804014327;

/**
 * The standard normal CDF, Abramowitz & Stegun 26.2.17. Maximum absolute
 * error 7.5e-8 — about 1e-6 USD on a 10 USD premium, four orders of magnitude
 * below the +0.02 measured fit and far below any figure this app renders.
 * Evaluated on |x| and reflected, so the tail that loses precision is always
 * the small one.
 */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const ax = Math.abs(x);
  const t = 1 / (1 + A_S_P * ax);
  const density = INV_SQRT_2PI * Math.exp((-ax * ax) / 2);
  const poly =
    t * (A_S_B[0] + t * (A_S_B[1] + t * (A_S_B[2] + t * (A_S_B[3] + t * A_S_B[4]))));
  // `upper` is the right tail P(X > ax); reflect for the left side.
  const upper = density * poly;
  return x >= 0 ? 1 - upper : upper;
}

/** The Black-Scholes `d1`. NaN on a degenerate input — callers check. */
export function d1(S: number, K: number, T: number, sigma: number, r: number): number {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return Number.NaN;
  return (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
}

/**
 * European call/put price with NO explicit dividend term — dividends land in
 * the recovered `r`, which is exactly why recovering it beats guessing it
 * (ZORA, a dividend-heavy name, recovers a legitimately NEGATIVE −0.22%).
 * Returns null on any non-finite intermediate rather than a plausible-looking
 * NaN-derived figure.
 */
export function bsPrice(input: BsInput): number | null {
  const { type, S, K, T, sigma, r } = input;
  const a = d1(S, K, T, sigma, r);
  if (!Number.isFinite(a)) return null;
  const b = a - sigma * Math.sqrt(T);
  const discounted = K * Math.exp(-r * T);
  const price =
    type === 'call'
      ? S * normCdf(a) - discounted * normCdf(b)
      : discounted * normCdf(-b) - S * normCdf(-a);
  return Number.isFinite(price) ? price : null;
}

export interface RateRecoveryInput {
  type: OptionType;
  S: number;
  K: number;
  T: number;
  sigma: number;
  /** The VENDOR's own delta: `(0,1)` for a call, `(−1,0)` for a put. */
  delta: number;
}

/** Bisection bracket for the carry rate — anything outside is not a rate. */
const RATE_LO = -0.5;
const RATE_HI = 0.5;

/**
 * Plausibility band for the RECOVERED rate, distinct from the bisection
 * bracket above. The bracket must stay wide enough to contain the root; this
 * band decides whether the root we found is a carry rate at all.
 *
 * Bisection converging is not the same as bisection being right. Measured on
 * the real code: a 7-day near-the-money contract whose delta and spot were
 * captured moments apart resolves to r = −49.9%, and the resulting mark clears
 * every downstream gate (finite, positive, above intrinsic, below spot) and
 * renders as a confident estimate. At |r| = 0.5 on a short contract the
 * discount term `K·r·T` is a large fraction of the premium, so the fit is not
 * pricing the option — it is absorbing a delta/spot timing mismatch into the
 * one free parameter.
 *
 * Real carry (rate minus dividend yield) sits well inside ±15%; the three
 * verified fixtures recovered 2.09%, −0.22% and 2.25%. Outside the band we
 * fail closed and the contract keeps its traded price, per the plan's rule
 * that a bad fit must never be priced with.
 */
const RATE_PLAUSIBLE_ABS = 0.15;
const RATE_TOLERANCE = 1e-10;
const MAX_ITERATIONS = 200;

/**
 * Recovers `r` from the vendor's delta: solve `N(d1(r)) = delta` (call) or
 * `= delta + 1` (put — the standard put-delta convention). `d1` is strictly
 * increasing in `r` and `N` is strictly increasing, so `N(d1(r))` is monotone
 * increasing in `r` and bisection over `[−0.5, 0.5]` is well defined.
 *
 * Fails CLOSED — returns null on a target outside `(0,1)`, a degenerate
 * input, a non-bracketing interval or non-convergence. It never clamps `r` to
 * a bracket end: a clamped rate would silently invent a precise-looking price.
 */
export function recoverRate(input: RateRecoveryInput): number | null {
  const { type, S, K, T, sigma, delta } = input;
  if (!Number.isFinite(delta)) return null;
  const target = type === 'call' ? delta : delta + 1;
  if (!(target > 0) || !(target < 1)) return null;

  const residual = (r: number): number => {
    const value = normCdf(d1(S, K, T, sigma, r));
    return Number.isFinite(value) ? value - target : Number.NaN;
  };

  let lo = RATE_LO;
  let hi = RATE_HI;
  const fLo = residual(lo);
  const fHi = residual(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  // The root must be bracketed; an escaping target is a fallback, not a guess.
  if (!(fLo < 0) || !(fHi > 0)) {
    if (Math.abs(fLo) < RATE_TOLERANCE) return plausibleRate(lo);
    if (Math.abs(fHi) < RATE_TOLERANCE) return plausibleRate(hi);
    return null;
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const fMid = residual(mid);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < RATE_TOLERANCE) return plausibleRate(mid);
    if (fMid < 0) lo = mid;
    else hi = mid;
  }
  return null;
}

/** A recovered rate outside the plausible carry band is a failed fit, not a
 *  rate — null so the caller falls back to the traded price. */
function plausibleRate(rate: number): number | null {
  return Math.abs(rate) <= RATE_PLAUSIBLE_ABS ? rate : null;
}

export interface MarkInput extends RateRecoveryInput {
  type: OptionType;
}

export interface BsMark {
  mark: number;
  /** The recovered carry rate — stored with the mark so it can be audited. */
  rate: number;
}

/**
 * The composition: recover `r` from the vendor's delta, then price at that
 * same `T`. Null whenever the recovery fails or the price is not finite —
 * every caller treats null as "fall back to the traded price", never as zero.
 */
export function bsMark(input: MarkInput): BsMark | null {
  const rate = recoverRate(input);
  if (rate === null) return null;
  const mark = bsPrice({
    type: input.type,
    S: input.S,
    K: input.K,
    T: input.T,
    sigma: input.sigma,
    r: rate,
  });
  if (mark === null) return null;
  return { mark, rate };
}
