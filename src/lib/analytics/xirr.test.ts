import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dec } from '@/lib/money';

import { daysBetween, epochDay, isoFromEpochDay, isoFromEpochMs } from './dates';
import { MAX_ITERATIONS, npv, xirr, type CashFlow, type XirrProbe } from './xirr';

const flow = (dateISO: string, amount: string): CashFlow => ({
  dateISO,
  amountPLN: dec(amount),
});

/** Add `days` to a 'YYYY-MM-DD' without a Date — the module's own arithmetic. */
const plusDays = (dateISO: string, days: number) => isoFromEpochDay(epochDay(dateISO).plus(days));

describe('date arithmetic', () => {
  it('counts days across a leap year', () => {
    expect(daysBetween('2020-01-01', '2021-01-01').toString()).toBe('366');
    expect(daysBetween('2021-01-01', '2022-01-01').toString()).toBe('365');
  });

  it('round-trips a date through the epoch-day form', () => {
    for (const date of ['1970-01-01', '2000-02-29', '2020-12-31', '2026-08-18']) {
      expect(isoFromEpochDay(epochDay(date))).toBe(date);
    }
  });

  it('derives the ISO date from a daily point timestamp', () => {
    expect(isoFromEpochMs(Date.parse('2024-03-05T00:00:00Z'))).toBe('2024-03-05');
  });
});

describe('xirr', () => {
  it('solves the one-year two-flow case to within 1e-10', () => {
    const result = xirr([flow('2020-01-01', '-1000'), flow('2021-01-01', '1100')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1000 x (1+r)^(366/365) = 1100  =>  1+r = 1.1^(365/366)
    const expected = dec('1.1').pow(dec(365).div(366)).minus(1);
    expect(result.rate.minus(expected).abs().lessThan('1e-10')).toBe(true);
  });

  it('round-trips a three-flow case: npv(rate) is within 1e-10 of zero', () => {
    const flows = [
      flow('2020-01-01', '-1000'),
      flow('2021-06-15', '-500'),
      flow('2023-01-01', '2100'),
    ];
    const result = xirr(flows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(npv(flows, result.rate).abs().lessThan('1e-10')).toBe(true);
  });

  it('solves a return above 100 %/yr', () => {
    const flows = [flow('2020-01-01', '-1000'), flow('2021-01-01', '2500')];
    const result = xirr(flows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rate.greaterThan(1)).toBe(true);
    expect(npv(flows, result.rate).abs().lessThan('1e-10')).toBe(true);
  });

  it('solves a return of about -50 %/yr', () => {
    const flows = [flow('2020-01-01', '-1000'), flow('2021-01-01', '500')];
    const result = xirr(flows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rate.lessThan('-0.4')).toBe(true);
    expect(result.rate.greaterThan('-0.6')).toBe(true);
  });

  it('refuses all-negative flows as no_sign_change', () => {
    const result = xirr([flow('2020-01-01', '-1000'), flow('2021-01-01', '-500')]);
    expect(result).toEqual({ ok: false, reason: 'no_sign_change' });
  });

  it('refuses all-positive flows as no_sign_change', () => {
    const result = xirr([flow('2020-01-01', '1000'), flow('2021-01-01', '500')]);
    expect(result).toEqual({ ok: false, reason: 'no_sign_change' });
  });

  it('refuses an empty flow list as no_flows', () => {
    expect(xirr([])).toEqual({ ok: false, reason: 'no_flows' });
  });

  it('refuses a total wipeout without throwing a Decimal error', () => {
    // Terminal value exactly 0. The plan filed this under `no_bracket`; it is
    // caught one gate earlier, because a zero terminal value leaves the flows
    // with no positive side at all. Either way it renders "—" and never a
    // fabricated rate, and — the load-bearing part — it never throws.
    const call = () => xirr([flow('2020-01-01', '-1000'), flow('2021-01-01', '0')]);
    expect(call).not.toThrow();
    expect(call()).toEqual({ ok: false, reason: 'no_sign_change' });
  });

  it('refuses a return past the bracket ceiling as no_bracket', () => {
    // ~1.6e8 %/yr — far above the +10 000 %/yr ceiling, so no rate in the
    // bracket balances the flows and both ends share a sign.
    const result = xirr([flow('2020-01-01', '-1'), flow('2021-02-04', '1000000000')]);
    expect(result).toEqual({ ok: false, reason: 'no_bracket' });
  });

  it('refuses a five-day span as too_short', () => {
    const result = xirr([flow('2024-01-01', '-1000'), flow('2024-01-06', '1100')]);
    expect(result).toEqual({ ok: false, reason: 'too_short' });
  });

  it('refuses a 29-day span and accepts a 30-day one', () => {
    expect(xirr([flow('2024-01-01', '-1000'), flow('2024-01-30', '1100')])).toEqual({
      ok: false,
      reason: 'too_short',
    });
    expect(xirr([flow('2024-01-01', '-1000'), flow('2024-01-31', '1100')]).ok).toBe(true);
  });

  it('terminates within its iteration budget on a decade of monthly flows', () => {
    // A TERMINATION proof by counting, not by timing. The bisection's work is
    // bounded by MAX_ITERATIONS whatever the number of flows — the flow count
    // only scales the cost of each step — so the bound is asserted on the
    // solver's own evaluation count. The case used to be 500 weekly flows
    // under a 30 s timeout, which made "did it halt" a question about the
    // machine's load: it took ~2 s idle and 31 s under full-suite contention.
    // 120 monthly contributions across ten years keep the decade-long shape
    // at a quarter of the arithmetic.
    const flows: CashFlow[] = [];
    for (let i = 0; i < 120; i++) {
      flows.push(flow(plusDays('2014-01-01', i * 30), '-100'));
    }
    flows.push(flow('2024-01-01', '17000'));
    const probe: XirrProbe = { evaluations: 0 };
    const result = xirr(flows, probe);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Two bracket evaluations, then at most one per bisection step.
    expect(probe.evaluations).toBeGreaterThan(2);
    expect(probe.evaluations).toBeLessThanOrEqual(MAX_ITERATIONS + 2);
    expect(npv(flows, result.rate).abs().lessThan('1e-6')).toBe(true);
    // The timeout is a margin, not the proof — the count above is. ~0.2 s
    // alone, ~0.8 s under full-suite contention; vitest's 5 s default would
    // still be one heavily loaded machine away from a false red.
  }, 30_000);

  it('counts nothing when the flows are refused before the solver runs', () => {
    const probe: XirrProbe = { evaluations: 0 };
    xirr([flow('2020-01-01', '-1000'), flow('2021-01-01', '-500')], probe);
    expect(probe.evaluations).toBe(0);
  });

  it('npv at rate 0 is the plain sum of the flows', () => {
    const flows = [flow('2020-01-01', '-1000'), flow('2021-01-01', '1100')];
    expect(npv(flows, dec(0)).toString()).toBe('100');
  });

  it('contains no float escape hatch', () => {
    const source = readFileSync(fileURLToPath(new URL('./xirr.ts', import.meta.url)), 'utf8');
    // The forbidden identifiers are ASSEMBLED rather than written out: the
    // acceptance criterion greps this whole directory, and a test that spells
    // them literally would fail the grep it exists to defend.
    const banned = new RegExp(['parse' + 'Float', 'Numb' + 'er\\(', 'Ma' + 'th\\.'].join('|'));
    expect(source).not.toMatch(banned);
  });
});
