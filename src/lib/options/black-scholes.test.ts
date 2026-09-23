import { describe, expect, it } from 'vitest';

import { bsMark, bsPrice, d1, normCdf, recoverRate } from './black-scholes';

/**
 * The numerical core, pinned to the GOLDEN FIXTURES — measured live
 * 2026-08-15 against our own key and a reference quote source. These are
 * ground truth, not illustration: ACME 9.99 against a reference mid of 9.97,
 * ZORA 3.16 against 3.27, and IDXF 91.54 against a real last trade of 92.73 on
 * a liquid control (1.3% — the method is not overfitted to two thin names).
 *
 * `T` is ACT/365 on NY calendar dates from 2026-08-15 to expiry, the same day
 * count `option-mark.ts` computes.
 */

const MS_PER_DAY = 86_400_000;

function noon(dateISO: string): number {
  const [y, m, d] = dateISO.split('-');
  return Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), 12);
}

/** ACT/365 between two NY calendar dates. */
function years(fromISO: string, toISO: string): number {
  return (noon(toISO) - noon(fromISO)) / MS_PER_DAY / 365;
}

const TODAY = '2026-08-15';

const ACME = {
  type: 'call' as const,
  S: 196.21,
  K: 260,
  T: years(TODAY, '2027-03-19'),
  sigma: 0.4570918869866558,
  delta: 0.2777239463315493,
};

const ZORA = {
  type: 'call' as const,
  S: 73.79,
  K: 95,
  T: years(TODAY, '2027-03-19'),
  sigma: 0.4118177042206123,
  delta: 0.2600334521307547,
};

const IDXF = {
  type: 'call' as const,
  S: 776.34,
  K: 700,
  T: years(TODAY, '2026-12-18'),
  sigma: 0.21741383434743794,
  delta: 0.8258135982294877,
};

describe('normCdf — Abramowitz & Stegun 26.2.17', () => {
  // Reference values of the standard normal CDF.
  const REFERENCE: [number, number][] = [
    [-3, 0.0013498980316301],
    [-1, 0.1586552539314571],
    [0, 0.5],
    [1, 0.8413447460685429],
    [3, 0.9986501019683699],
  ];

  it.each(REFERENCE)('matches the reference value at %s within 1e-7', (x, expected) => {
    expect(Math.abs(normCdf(x) - expected)).toBeLessThan(1e-7);
  });

  it('is symmetric: N(−x) = 1 − N(x)', () => {
    for (const x of [0.25, 1.5, 2.75, 4]) {
      expect(Math.abs(normCdf(-x) - (1 - normCdf(x)))).toBeLessThan(1e-12);
    }
  });

  it('is monotone increasing and bounded by (0, 1)', () => {
    let previous = 0;
    for (let x = -5; x <= 5; x += 0.5) {
      const value = normCdf(x);
      expect(value).toBeGreaterThan(previous);
      expect(value).toBeLessThan(1);
      previous = value;
    }
  });
});

describe('bsPrice', () => {
  it('increases with volatility for a call — more uncertainty, more optionality', () => {
    const low = bsPrice({ ...ACME, r: 0.02, sigma: 0.3 });
    const high = bsPrice({ ...ACME, r: 0.02, sigma: 0.6 });
    expect(low).not.toBeNull();
    expect(high as number).toBeGreaterThan(low as number);
  });

  it('increases with the spot for a call', () => {
    const cheap = bsPrice({ ...ACME, r: 0.02, S: 180 });
    const dear = bsPrice({ ...ACME, r: 0.02, S: 210 });
    expect(cheap).not.toBeNull();
    expect(dear as number).toBeGreaterThan(cheap as number);
  });

  it('returns null on a degenerate input (T = 0) rather than a NaN-derived figure', () => {
    expect(bsPrice({ ...ACME, r: 0.02, T: 0 })).toBeNull();
    expect(bsPrice({ ...ACME, r: 0.02, sigma: 0 })).toBeNull();
    expect(bsPrice({ ...ACME, r: 0.02, S: 0 })).toBeNull();
  });

  it('puts and calls satisfy put-call parity at the same inputs', () => {
    const r = 0.02;
    const call = bsPrice({ ...ACME, r }) as number;
    const put = bsPrice({ ...ACME, type: 'put', r }) as number;
    const parity = ACME.S - ACME.K * Math.exp(-r * ACME.T);
    expect(Math.abs(call - put - parity)).toBeLessThan(1e-6);
  });
});

describe('recoverRate — the carry rate is RECOVERED, never assumed', () => {
  it('reproduces the measured ACME rate of 2.09%', () => {
    expect(Math.abs((recoverRate(ACME) as number) - 0.0209)).toBeLessThan(1e-4);
  });

  it('reproduces the measured ZORA rate of −0.22% — a negative rate is legitimate', () => {
    const rate = recoverRate(ZORA) as number;
    expect(rate).toBeLessThan(0);
    expect(Math.abs(rate - -0.0022)).toBeLessThan(1e-4);
  });

  it('reproduces the measured IDXF rate of 2.25% on the liquid control', () => {
    expect(Math.abs((recoverRate(IDXF) as number) - 0.0225)).toBeLessThan(1e-4);
  });

  it('reproduces the vendor delta exactly at the recovered rate', () => {
    const r = recoverRate(ACME) as number;
    const nd1 = normCdf(d1(ACME.S, ACME.K, ACME.T, ACME.sigma, r));
    expect(Math.abs(nd1 - ACME.delta)).toBeLessThan(1e-9);
  });

  it('fails closed on a delta at or outside the bounds', () => {
    expect(recoverRate({ ...ACME, delta: 0 })).toBeNull();
    expect(recoverRate({ ...ACME, delta: 1 })).toBeNull();
    expect(recoverRate({ ...ACME, delta: -0.5 })).toBeNull();
    expect(recoverRate({ ...ACME, delta: 1.5 })).toBeNull();
  });

  it('fails closed on a degenerate sigma or T', () => {
    expect(recoverRate({ ...ACME, sigma: 0 })).toBeNull();
    expect(recoverRate({ ...ACME, T: 0 })).toBeNull();
  });

  it('fails closed — never clamps — when the target escapes the [−0.5, 0.5] bracket', () => {
    // A far-OTM contract whose delta is unreachable inside the rate bracket.
    expect(
      recoverRate({ type: 'call', S: 10, K: 500, T: 0.05, sigma: 0.1, delta: 0.99 }),
    ).toBeNull();
  });

  it('uses the put convention: N(d1) = delta + 1', () => {
    const put = { type: 'put' as const, S: 100, K: 110, T: 0.5, sigma: 0.3, delta: -0.55 };
    const r = recoverRate(put) as number;
    expect(r).not.toBeNull();
    const nd1 = normCdf(d1(put.S, put.K, put.T, put.sigma, r));
    expect(Math.abs(nd1 - (put.delta + 1))).toBeLessThan(1e-9);
  });
});

describe('bsMark — the golden fixtures, to the cent', () => {
  it('prices ACME at 9.99 (reference mid 9.97; the last trade was 12.10)', () => {
    const result = bsMark(ACME);
    expect(result).not.toBeNull();
    expect(Math.abs((result as { mark: number }).mark - 9.99)).toBeLessThan(0.005);
  });

  it('prices ZORA at 3.16 (reference mid 3.27; the last trade was a 3.90 fill)', () => {
    const result = bsMark(ZORA);
    expect(Math.abs((result as { mark: number }).mark - 3.16)).toBeLessThan(0.005);
  });

  it('prices the liquid IDXF control at 91.54 against a real last trade of 92.73', () => {
    const result = bsMark(IDXF);
    expect(Math.abs((result as { mark: number }).mark - 91.54)).toBeLessThan(0.005);
  });

  it('carries the recovered rate with the mark, so a stored mark can be audited', () => {
    const result = bsMark(ACME) as { mark: number; rate: number };
    expect(Math.abs(result.rate - 0.0209)).toBeLessThan(1e-4);
  });

  it('a HARDCODED rate is materially worse — which is why the calibration exists', () => {
    const at4 = bsPrice({ ...ACME, r: 0.04 }) as number;
    const at0 = bsPrice({ ...ACME, r: 0 }) as number;
    const calibrated = (bsMark(ACME) as { mark: number }).mark;
    // Measured: 10.50 at 4%, 9.45 at 0% — both ~0.5 out against the reference
    // 9.97, versus 0.02 with the recovered rate.
    expect(Math.abs(at4 - 9.97)).toBeGreaterThan(0.4);
    expect(Math.abs(at0 - 9.97)).toBeGreaterThan(0.4);
    expect(Math.abs(calibrated - 9.97)).toBeLessThan(0.1);
  });

  it('returns null whenever the rate recovery fails', () => {
    expect(bsMark({ ...ACME, delta: 1 })).toBeNull();
    expect(bsMark({ ...ACME, T: 0 })).toBeNull();
  });
});

describe('an implausible recovered rate fails closed', () => {
  it('rejects the 7-day near-the-money fit that resolves to −49.9% carry', () => {
    // Found by the bug audit against this exact code. Bisection CONVERGES
    // here — it does not clamp, it does not error — and the resulting mark
    // (≈3.57) clears every downstream gate and would render as a confident
    // estimate. The rate is the tell: −49.9% is not a carry rate, it is the
    // fit absorbing a delta/spot timing mismatch into its one free parameter.
    // On a 7-day contract the discount term is a large slice of the premium,
    // so this is not a rounding concern.
    expect(bsMark({ type: 'call', S: 196.21, K: 196, T: 7 / 365, sigma: 0.4, delta: 0.45 })).toBeNull();
  });

  it('still prices the three verified fixtures, whose rates are ordinary', () => {
    // The guard must not be so tight that it disables the feature: the real
    // recovered rates were 2.09%, −0.22% and 2.25%.
    expect(bsMark({ type: 'call', S: 196.21, K: 260, T: 216 / 365, sigma: 0.4570918869866558, delta: 0.2777239463315493 })).not.toBeNull();
    expect(bsMark({ type: 'call', S: 73.79, K: 95, T: 216 / 365, sigma: 0.4118177042206123, delta: 0.2600334521307547 })).not.toBeNull();
    expect(bsMark({ type: 'call', S: 776.34, K: 700, T: 125 / 365, sigma: 0.21741383434743794, delta: 0.8258135982294877 })).not.toBeNull();
  });
});
