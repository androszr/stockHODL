import { describe, expect, it } from 'vitest';

import type { ChartPoint } from '@/lib/charts/series';
import { dec } from '@/lib/money';

import { buildBenchmark } from './benchmark';

const at = (dateISO: string) => Date.parse(`${dateISO}T00:00:00Z`);
const point = (dateISO: string, v: string): ChartPoint => ({ t: at(dateISO), v });

const portfolio = [
  point('2024-01-02', '1000'),
  point('2024-01-03', '1100'),
  point('2024-01-04', '900'),
];

const spy = new Map([
  ['2024-01-02', '400'],
  ['2024-01-03', '410'],
  ['2024-01-04', '390'],
]);

const fx = new Map([
  ['2024-01-02', '4'],
  ['2024-01-03', '4'],
  ['2024-01-04', '5'],
]);

describe('buildBenchmark', () => {
  it('rebases both series to exactly 100 at the shared anchor', () => {
    const result = buildBenchmark(portfolio, spy, fx);
    expect(result.degradedReason).toBeNull();
    expect(result.portfolio[0].v).toBe('100');
    expect(result.benchmark[0].v).toBe('100');
  });

  it('indexes the portfolio by its own value ratio', () => {
    const { portfolio: line } = buildBenchmark(portfolio, spy, fx);
    expect(line.map((p) => p.v)).toEqual(['100', '110', '90']);
  });

  it('converts SPY to PLN before rebasing', () => {
    const { benchmark } = buildBenchmark(portfolio, spy, fx);
    // 400x4 = 1600 base; 410x4 = 1640 -> 102.5; 390x5 = 1950 -> 121.875.
    // The last point moves on the FX rate, which is precisely the move an
    // unconverted USD benchmark would have hidden.
    expect(benchmark.map((p) => p.v)).toEqual(['100', '102.5', '121.875']);
  });

  it('emits both lines over the same timestamps', () => {
    const { portfolio: line, benchmark } = buildBenchmark(portfolio, spy, fx);
    expect(line.map((p) => p.t)).toEqual(benchmark.map((p) => p.t));
  });

  it('drops a date present in only one series from BOTH', () => {
    const partialSpy = new Map([
      ['2024-01-02', '400'],
      ['2024-01-04', '390'],
    ]);
    const { portfolio: line, benchmark } = buildBenchmark(portfolio, partialSpy, fx);
    expect(line).toHaveLength(2);
    expect(benchmark).toHaveLength(2);
    expect(line.map((p) => p.t)).toEqual([at('2024-01-02'), at('2024-01-04')]);
  });

  it('drops a date with no FX rate from BOTH', () => {
    const partialFx = new Map([
      ['2024-01-02', '4'],
      ['2024-01-03', '4'],
    ]);
    const { portfolio: line, benchmark } = buildBenchmark(portfolio, spy, partialFx);
    expect(line).toHaveLength(2);
    expect(benchmark).toHaveLength(2);
  });

  it('refuses an empty SPY map rather than inventing a line', () => {
    const result = buildBenchmark(portfolio, new Map(), fx);
    expect(result.degradedReason).toBe('no_benchmark_history');
    expect(result.benchmark).toEqual([]);
    // One honest line beats none — and it is still on the INDEX scale, so it
    // does not draw PLN values against a baseline the caption calls 100.
    expect(result.portfolio.map((p) => p.v)).toEqual(['100', '110', '90']);
  });

  it('refuses a one-point intersection as no_benchmark_history', () => {
    const result = buildBenchmark(portfolio, new Map([['2024-01-03', '410']]), fx);
    expect(result.degradedReason).toBe('no_benchmark_history');
    expect(result.benchmark).toEqual([]);
  });

  it('walks the anchor past leading zero-value days', () => {
    const withLeadingZero = [point('2024-01-02', '0'), ...portfolio.slice(1)];
    const result = buildBenchmark(withLeadingZero, spy, fx);
    expect(result.degradedReason).toBeNull();
    expect(result.portfolio).toHaveLength(2);
    expect(result.portfolio[0].v).toBe('100');
    expect(dec(result.portfolio[1].v).toString()).toBe(
      dec(900).div(1100).times(100).toString(),
    );
  });

  it('refuses when nothing in the shared window can be indexed', () => {
    const allZero = [point('2024-01-02', '0'), point('2024-01-03', '0'), point('2024-01-04', '0')];
    const result = buildBenchmark(allZero, spy, fx);
    expect(result.degradedReason).toBe('no_baseline');
    expect(result.benchmark).toEqual([]);
    // Nothing positive to index against, so no fabricated line either.
    expect(result.portfolio).toEqual([]);
  });
});
