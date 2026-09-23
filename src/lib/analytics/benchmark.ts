import type Decimal from 'decimal.js';

import type { ChartPoint } from '@/lib/charts/series';
import { dec } from '@/lib/money';

import { isoFromEpochMs } from './dates';

/**
 * You against the market — pure, Decimal end to end.
 *
 * Both lines are REBASED TO INDEX 100 at the first date they share, so the
 * gap between them is the entire story and neither scale distracts from it.
 *
 * Two decisions worth keeping:
 *
 * - **SPY is converted to PLN before rebasing.** The portfolio is measured in
 *   PLN; an unconverted USD benchmark would attribute every currency move to
 *   stock picking.
 * - **Dates present in only one series are dropped from BOTH.** A benchmark
 *   drawn over a different date set is not a comparison. If the SPY map is
 *   empty, or fewer than two dates survive the intersection, the benchmark is
 *   EMPTY and `degradedReason` says why — the chart then draws one line and a
 *   caption. It never invents a second line.
 */

export type BenchmarkRefusal =
  /** No SPY closes at all, or under two dates shared with the portfolio. */
  | 'no_benchmark_history'
  /** The shared span exists but has no positive value to index against. */
  | 'no_baseline';

export interface BenchmarkResult {
  /** The portfolio line, rebased to 100 — including when degraded. */
  portfolio: ChartPoint[];
  /** The benchmark line, rebased to 100 — EMPTY whenever `degradedReason` is set. */
  benchmark: ChartPoint[];
  degradedReason: BenchmarkRefusal | null;
}

const INDEX_BASE = '100';

export function buildBenchmark(
  portfolioPoints: readonly ChartPoint[],
  /** 'YYYY-MM-DD' → SPY close, in USD (decimal strings). */
  spyCloses: ReadonlyMap<string, string>,
  /** 'YYYY-MM-DD' → USD→PLN rate, densified by `getFxRatesForRange`. */
  usdPlnByDay: ReadonlyMap<string, string>,
): BenchmarkResult {
  /**
   * One line, still on the index scale. Passing the raw PLN values through
   * would draw a portfolio worth tens of thousands against a chart whose
   * caption and baseline both say 100 — an honest refusal rendered as a
   * broken axis. So the surviving line is rebased against its own first
   * positive value; with no positive value at all there is nothing to index
   * and the line is empty rather than fabricated.
   */
  const degraded = (reason: BenchmarkRefusal): BenchmarkResult => ({
    portfolio: rebaseAlone(portfolioPoints),
    benchmark: [],
    degradedReason: reason,
  });

  if (spyCloses.size === 0) return degraded('no_benchmark_history');

  // The intersection: every portfolio day for which SPY has both a close and
  // an FX rate. Dropped on either side, so the two lines cover one date set.
  const shared: { point: ChartPoint; dateISO: string; spyPLN: Decimal }[] = [];
  for (const point of portfolioPoints) {
    const dateISO = isoFromEpochMs(point.t);
    const close = spyCloses.get(dateISO);
    const rate = usdPlnByDay.get(dateISO);
    if (close === undefined || rate === undefined) continue;
    shared.push({ point, dateISO, spyPLN: dec(close).times(dec(rate)) });
  }

  if (shared.length < 2) return degraded('no_benchmark_history');

  // The anchor is the first shared date at which BOTH series have something
  // to index against. A zero portfolio value (nothing held yet) cannot be a
  // denominator, so the anchor walks forward rather than producing Infinity.
  const anchorIndex = shared.findIndex(
    (entry) => dec(entry.point.v).greaterThan(0) && entry.spyPLN.greaterThan(0),
  );
  if (anchorIndex === -1 || shared.length - anchorIndex < 2) return degraded('no_baseline');

  const window = shared.slice(anchorIndex);
  const portfolioBase = dec(window[0].point.v);
  const benchmarkBase = window[0].spyPLN;

  const portfolio: ChartPoint[] = [];
  const benchmark: ChartPoint[] = [];
  for (const entry of window) {
    const t = entry.point.t;
    portfolio.push({
      t,
      v: dec(entry.point.v).div(portfolioBase).times(INDEX_BASE).toString(),
    });
    benchmark.push({ t, v: entry.spyPLN.div(benchmarkBase).times(INDEX_BASE).toString() });
  }

  return { portfolio, benchmark, degradedReason: null };
}

/** Rebase one series to 100 at its first positive value; empty if it has none. */
function rebaseAlone(points: readonly ChartPoint[]): ChartPoint[] {
  const anchorIndex = points.findIndex((point) => dec(point.v).greaterThan(0));
  if (anchorIndex === -1) return [];
  const base = dec(points[anchorIndex].v);
  return points
    .slice(anchorIndex)
    .map((point) => ({ t: point.t, v: dec(point.v).div(base).times(INDEX_BASE).toString() }));
}
