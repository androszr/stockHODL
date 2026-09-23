import type { ChartPoint } from '@/lib/charts/series';
import { dec, toNumeric, ZERO } from '@/lib/money';

import {
  downsampleDayLine,
  toSessionPercentSeries,
  type SessionBounds,
  type WidgetDayPoint,
} from './day-line';

/**
 * Options book value on a 5-minute grid — pure: carry-forward last print per
 * OCC ticker, never interpolate. USD-only by construction (lots have no FX).
 *
 * An unpriced ticker (no previous-close seed) is excluded, never zeroed.
 */

export interface OptionIntradayLot {
  ticker: string;
  quantity: string;
  sharesPerContract: string;
}

export interface OptionPrint {
  t: number;
  close: string;
}

function bookValueAt(
  lots: readonly OptionIntradayLot[],
  lastClose: ReadonlyMap<string, string>,
): string | null {
  let sum = ZERO;
  let any = false;
  for (const lot of lots) {
    const close = lastClose.get(lot.ticker);
    if (close === undefined) continue;
    any = true;
    sum = sum.plus(dec(close).times(dec(lot.quantity)).times(dec(lot.sharesPerContract)));
  }
  return any ? toNumeric(sum) : null;
}

/**
 * Instant-by-instant book value inside `session`, seeded with each ticker's
 * previous close. Prints outside the session are ignored. A ticker with no
 * seed is dropped from the book entirely. No in-session prints → no path
 * (a seed-only flat is not a session path).
 */
export function optionsSessionValuePoints(
  lots: readonly OptionIntradayLot[],
  printsByTicker: ReadonlyMap<string, readonly OptionPrint[]>,
  seedByTicker: ReadonlyMap<string, string>,
  session: SessionBounds,
  carryToMs?: number,
): ChartPoint[] {
  const seededLots = lots.filter((lot) => seedByTicker.has(lot.ticker));
  if (seededLots.length === 0) return [];

  const lastClose = new Map<string, string>();
  for (const [ticker, seed] of seedByTicker) lastClose.set(ticker, seed);

  const events: { t: number; close: string; ticker: string }[] = [];
  for (const [ticker, prints] of printsByTicker) {
    if (!seedByTicker.has(ticker)) continue;
    for (const print of prints) {
      if (print.t < session.openMs || print.t >= session.closeMs) continue;
      events.push({ t: print.t, close: print.close, ticker });
    }
  }
  events.sort((a, b) => a.t - b.t || a.ticker.localeCompare(b.ticker));
  // Seed + carry with no prints is a flat 0% path. Combined would draw it
  // on the clock beside a non-zero live day%; a silent book is no path.
  if (events.length === 0) return [];

  const points: ChartPoint[] = [];
  const openValue = bookValueAt(seededLots, lastClose);
  if (openValue !== null) points.push({ t: session.openMs, v: openValue });

  for (const event of events) {
    lastClose.set(event.ticker, event.close);
    const value = bookValueAt(seededLots, lastClose);
    if (value === null) continue;
    const prev = points[points.length - 1];
    if (prev && prev.t === event.t) {
      prev.v = value;
      continue;
    }
    points.push({ t: event.t, v: value });
  }

  const last = points[points.length - 1];
  const end = carryToMs === undefined ? session.closeMs : carryToMs;
  if (last && end > last.t && end <= session.closeMs) {
    points.push({ t: end, v: last.v });
  }

  return points;
}

/** Percent series vs the previous-close book, downsampled. */
export function optionsSessionPercentSeries(
  lots: readonly OptionIntradayLot[],
  printsByTicker: ReadonlyMap<string, readonly OptionPrint[]>,
  seedByTicker: ReadonlyMap<string, string>,
  session: SessionBounds,
  carryToMs?: number,
): WidgetDayPoint[] {
  const valuePoints = optionsSessionValuePoints(
    lots,
    printsByTicker,
    seedByTicker,
    session,
    carryToMs,
  );
  const baseline = bookValueAt(
    lots.filter((lot) => seedByTicker.has(lot.ticker)),
    seedByTicker,
  );
  if (baseline === null) return [];
  return downsampleDayLine(toSessionPercentSeries(valuePoints, baseline));
}
