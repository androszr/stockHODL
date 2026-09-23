import { dec, type Money } from '@/lib/money';

import type { ClosePoint, ValuationSource } from './day-trend';

/**
 * A whole book's five-session strip — the Dashboard's "Total value" box and
 * the "Options" total draw the same lights every tile draws, but over the
 * SUM of the positions rather than one price (2026-09-21).
 *
 * PURE, like `day-trend.ts`: this file only turns per-position valuations
 * into per-session total valuations; the caller grades them with
 * `toTrendDays` on the class's own scale. The one rule worth stating is the
 * hole rule: a session's total exists only when EVERY position has a figure
 * for it. Summing the ones that happen to be there would report a book that
 * shrank because a row was missing, which is exactly the lie the per-tile
 * grader refuses to tell.
 *
 * Quantities are the CURRENT ones, applied to every session — "how would
 * what I hold now have moved", the same question a stock tile's price strip
 * answers, and the only one answerable without replaying the trade tape.
 */

export interface TotalPosition {
  /** Key into `valuationsByKey` — an instrument id or an OCC ticker. */
  key: string;
  /** Contract multiplier × lots, or plain share count — a decimal string. */
  units: string;
  /** Currency of the valuation; 'PLN' needs no rate. */
  currency: string;
}

export function totalValuationPoints(
  sessions: readonly string[],
  positions: readonly TotalPosition[],
  valuationsByKey: ReadonlyMap<string, readonly ClosePoint[]>,
  /** Currency → session date → rate to PLN. Ignored for a 'PLN' position. */
  fxByCurrency: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
  /** Set when the total should stay in the position currency (the options book, USD). */
  options: { convert: boolean } = { convert: true },
): ClosePoint[] {
  if (positions.length === 0) return [];
  const indexed = new Map<string, Map<string, ClosePoint>>();
  for (const [key, points] of valuationsByKey) {
    indexed.set(key, new Map(points.map((point) => [point.asOf, point])));
  }

  const totals: ClosePoint[] = [];
  for (const session of sessions) {
    let sum: Money = dec(0);
    let source: ValuationSource = 'close';
    let complete = true;
    for (const position of positions) {
      const point = indexed.get(position.key)?.get(session);
      if (point === undefined) {
        complete = false;
        break;
      }
      let rate = '1';
      if (options.convert && position.currency !== 'PLN') {
        const found = fxByCurrency.get(position.currency)?.get(session);
        if (found === undefined) {
          complete = false;
          break;
        }
        rate = found;
      }
      sum = sum.plus(dec(position.units).times(dec(point.close)).times(dec(rate)));
      // One model mark anywhere in the session makes the TOTAL a mark: the
      // grader then holes the boundary where the mix changes.
      if (point.source === 'mark') source = 'mark';
    }
    if (complete) totals.push({ asOf: session, close: sum.toString(), source });
  }
  return totals;
}
