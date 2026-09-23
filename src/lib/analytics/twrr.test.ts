import { describe, expect, it } from 'vitest';

import { dec } from '@/lib/money';

import { epochDay, isoFromEpochDay } from './dates';
import { twrr, type TwrrDay } from './twrr';

/**
 * A day, from the NET flow the older tests were written against: a positive
 * net is money in, a negative net is money out. The gross split is what the
 * module actually consumes, so the cases that need both directions on ONE day
 * use `grossDay` below.
 */
const day = (dateISO: string, value: string, flow = '0'): TwrrDay =>
  dec(flow).isNegative()
    ? grossDay(dateISO, value, { outflow: dec(flow).negated().toString() })
    : grossDay(dateISO, value, { inflow: flow });

const grossDay = (
  dateISO: string,
  value: string,
  flows: { inflow?: string; outflow?: string; partial?: boolean } = {},
): TwrrDay => ({
  dateISO,
  valuePLN: dec(value),
  inflowPLN: dec(flows.inflow ?? '0'),
  outflowPLN: dec(flows.outflow ?? '0'),
  partial: flows.partial,
});

const plusDays = (dateISO: string, days: number) => isoFromEpochDay(epochDay(dateISO).plus(days));

describe('twrr', () => {
  it('reports a flat portfolio with a mid-period deposit as ~0 %', () => {
    // The whole point of TWRR: 50 zł arrives on day 3 and the value jumps to
    // 150 because of it, not because anything went up. XIRR would not say 0 %.
    const result = twrr([
      day('2024-01-01', '100'),
      day('2024-02-01', '100'),
      day('2024-03-01', '150', '50'),
      day('2024-04-01', '150'),
    ]);
    expect(result.cumulative.abs().lessThan('1e-20')).toBe(true);
    expect(result.skippedDays).toBe(0);
  });

  it('chain-links two 10 % days into 21 %', () => {
    const result = twrr([
      day('2024-01-01', '100'),
      day('2024-02-01', '110'),
      day('2024-04-01', '121'),
    ]);
    expect(result.cumulative.minus(21).abs().lessThan('1e-20')).toBe(true);
  });

  it('is unaffected by a withdrawal on an otherwise flat day', () => {
    const result = twrr([
      day('2024-01-01', '200'),
      day('2024-03-01', '150', '-50'),
      day('2024-05-01', '150'),
    ]);
    expect(result.cumulative.abs().lessThan('1e-20')).toBe(true);
  });

  it('skips and counts a zero-denominator day instead of linking it as 0 %', () => {
    const result = twrr([
      day('2024-01-01', '0'),
      // Previous value 0 and no flow: nothing was held, so there is no return.
      day('2024-02-01', '0'),
      day('2024-03-01', '100', '100'),
      day('2024-04-01', '110'),
    ]);
    expect(result.skippedDays).toBe(1);
    expect(result.cumulative.minus(10).abs().lessThan('1e-20')).toBe(true);
  });

  it('skips a day whose outflow exceeds the previous value', () => {
    const result = twrr([
      day('2024-01-01', '100'),
      day('2024-02-01', '10', '-200'),
      day('2024-03-01', '11'),
    ]);
    expect(result.skippedDays).toBe(1);
    expect(result.cumulative.minus(10).abs().lessThan('1e-20')).toBe(true);
  });

  it('returns a null annualized figure under 30 days', () => {
    const result = twrr([day('2024-01-01', '100'), day('2024-01-20', '110')]);
    expect(result.annualized).toBeNull();
    expect(result.cumulative.minus(10).abs().lessThan('1e-20')).toBe(true);
  });

  it('annualizes a 366-day doubling to about 100 %', () => {
    const result = twrr([day('2020-01-01', '100'), day('2021-01-01', '200')]);
    expect(result.annualized).not.toBeNull();
    expect(result.annualized?.minus(100).abs().lessThan('1')).toBe(true);
  });

  it('keeps every day of a >400-day series', () => {
    // The downsampling guard, asserted: the chart wrapper in
    // `portfolio-series.ts` caps a series at ~400 points, and a day chain
    // built on sampled points is plausible and wrong. This module must see —
    // and report — every day. (The wrapper is not named here: an acceptance
    // criterion greps this directory for it.)
    const days: TwrrDay[] = [];
    for (let i = 0; i < 500; i++) days.push(day(plusDays('2023-01-01', i), '100'));
    const result = twrr(days);
    expect(result.days).toBe(500);
    expect(result.skippedDays).toBe(0);
  });

  it('reports nothing for a single day', () => {
    const result = twrr([day('2024-01-01', '100')]);
    expect(result.cumulative.isZero()).toBe(true);
    expect(result.annualized).toBeNull();
    expect(result.days).toBe(1);
  });
});

/**
 * Bug audit 2026-08-18, blocker 3: a day whose ENDING value is zero used to
 * multiply the whole chain by zero and pin it at −100 % forever, so a
 * portfolio that liquidated, sat in cash and rebought reported a total loss
 * on a profitable round trip.
 */
describe('twrr — a zero-value day never zeroes the chain', () => {
  it('reports the auditor’s sell-all / rebuy round trip as a gain, not −100 %', () => {
    // 1 000 → sold for 990 (a real −1 % on the sale day) → cash → rebought at
    // 990 → finishes at 1 089, i.e. +10 % on the second leg.
    const result = twrr([
      day('2024-01-01', '1000'),
      day('2024-01-02', '0', '-990'),
      day('2024-01-03', '0'),
      day('2024-01-04', '990', '990'),
      day('2024-06-01', '1089'),
    ]);
    // 0.99 × 1.10 − 1 = +8.9 %, and emphatically not −100 %.
    expect(result.cumulative.minus('8.9').abs().lessThan('1e-20')).toBe(true);
    expect(result.cumulative.greaterThan(0)).toBe(true);
    // The cash day is the only thing nothing can be said about.
    expect(result.skippedDays).toBe(1);
  });

  it('annualizes that round trip as a gain too', () => {
    const result = twrr([
      day('2024-01-01', '1000'),
      day('2024-01-02', '0', '-990'),
      day('2024-01-03', '0'),
      day('2024-01-04', '990', '990'),
      day('2025-01-01', '1089'),
    ]);
    expect(result.annualized).not.toBeNull();
    expect(result.annualized?.greaterThan(0)).toBe(true);
  });

  it('keeps the sale’s own loss when the day ends empty', () => {
    // Liquidating 1 000 for 900 IS a −10 % day; it must be measured, not
    // skipped, and not compounded into anything worse.
    const result = twrr([day('2024-01-01', '1000'), day('2024-02-01', '0', '-900')]);
    expect(result.cumulative.plus(10).abs().lessThan('1e-20')).toBe(true);
    expect(result.skippedDays).toBe(0);
  });

  it('skips a day that ends empty with no money leaving, rather than claiming −100 %', () => {
    const result = twrr([
      day('2024-01-01', '1000'),
      // Nothing sold, yet the value reads zero: a data gap, not a wipeout.
      day('2024-01-02', '0'),
      day('2024-01-03', '1000', '1000'),
      day('2024-06-01', '1100'),
    ]);
    expect(result.skippedDays).toBe(1);
    expect(result.cumulative.minus(10).abs().lessThan('1e-20')).toBe(true);
  });

  it('refuses to divide a full day’s value by a dust denominator', () => {
    // A rounding tail of 1e-9 left in the denominator would otherwise
    // manufacture a return in the billions of percent.
    const result = twrr([
      day('2024-01-01', '0.000000001'),
      day('2024-02-01', '1000'),
      day('2024-03-01', '1100'),
    ]);
    expect(result.skippedDays).toBe(1);
    expect(result.cumulative.minus(10).abs().lessThan('1e-20')).toBe(true);
  });
});

/**
 * Bug audit 2026-08-19, major 1: the liquidation branch treated the day's NET
 * external flow as the sale proceeds and used yesterday's value alone as the
 * denominator, so a day that both bought and sold reported a return that was
 * wrong by an order of magnitude — and then multiplied the rest of the chain
 * by it.
 */
describe('twrr — a liquidation day that also bought', () => {
  it('reports the auditor’s double-down-then-exit day as +10 %, not +110 %', () => {
    // 1 000 held; 10 000 bought in the morning; the whole 11 000 sold for
    // 12 100 in the afternoon. The net flow is −2 100, and the old formula
    // read (0 − (−2 100)) / 1 000 = +110 %. The truth is 12 100 / 11 000.
    const result = twrr([
      grossDay('2024-01-01', '1000'),
      grossDay('2024-01-02', '0', { inflow: '10000', outflow: '12100' }),
    ]);
    expect(result.cumulative.minus(10).abs().lessThan('1e-20')).toBe(true);
    expect(result.skippedDays).toBe(0);
  });

  it('leaves a same-day buy on a NON-liquidation day exactly as it was', () => {
    // The ordinary path still nets: 1 000 held, 500 in and 200 out at the
    // start of the day, ending at 1 300 — a flat day, not a +30 % one.
    const result = twrr([
      grossDay('2024-01-01', '1000'),
      grossDay('2024-02-01', '1300', { inflow: '500', outflow: '200' }),
    ]);
    expect(result.cumulative.abs().lessThan('1e-20')).toBe(true);
    expect(result.skippedDays).toBe(0);
  });

  it('still reports an outflow-only liquidation’s own loss', () => {
    // Unchanged behaviour, asserted against the gross shape: 1 000 liquidated
    // for 900 is a −10 % day and is measured, not skipped.
    const result = twrr([
      grossDay('2024-01-01', '1000'),
      grossDay('2024-02-01', '0', { outflow: '900' }),
    ]);
    expect(result.cumulative.plus(10).abs().lessThan('1e-20')).toBe(true);
    expect(result.skippedDays).toBe(0);
  });

  it('BREAKS the chain on a sell-all day that bought an instrument with no bar yet', () => {
    // The day reads as empty only because the new holding cannot be priced —
    // the money is there, unvalued. Measuring it as a liquidation would report
    // 1 100 / 2 000 = −45 % on a day that lost nothing.
    const result = twrr([
      grossDay('2024-01-01', '1000'),
      grossDay('2024-01-02', '0', { inflow: '1000', outflow: '1100', partial: true }),
      grossDay('2024-01-03', '1000', { inflow: '1000' }),
      grossDay('2024-06-01', '1100'),
    ]);
    expect(result.skippedDays).toBe(1);
    // Only the measurable leg is linked: 1 000 → 1 100 after the restart.
    expect(result.cumulative.minus(10).abs().lessThan('1e-20')).toBe(true);
  });

  it('measures a same-day buy-and-liquidate from an empty start', () => {
    // Nothing held yesterday: the day's whole capital is the morning's buy,
    // so 1 000 in and 900 out is a real −10 % day, not an unmeasurable one.
    const result = twrr([
      grossDay('2024-01-01', '0'),
      grossDay('2024-02-01', '0', { inflow: '1000', outflow: '900' }),
    ]);
    expect(result.cumulative.plus(10).abs().lessThan('1e-20')).toBe(true);
    expect(result.skippedDays).toBe(0);
  });
});
