import 'server-only';

import { getFxRatesForRange } from '@/lib/fx/nbp';
import { getRecentCloses } from '@/lib/history/recent-changes';
import { getRecentOptionValuations } from '@/lib/options/recent-valuations';
import { readStoredCalendar } from '@/lib/market-data/calendar-store';
import { recentSessionDatesISO } from '@/lib/market-data/market-clock';

import {
  TREND_SESSIONS_NEEDED,
  isEmptyStrip,
  toTrendDays,
  type TrendSlot,
} from './day-trend';
import { totalValuationPoints, type TotalPosition } from './total-trend';
import { EQUITY_TREND_SCALE, OPTION_TREND_SCALE } from './trend-scale';

/**
 * The five-session trend strips for an instrument set, best-effort: ONE batched
 * query, graded in memory against the real session calendar.
 *
 * Its own module rather than a helper inside `live-view.ts`, because the
 * watchlist needs it too and `live-view.ts` imports the vendor adapter, the
 * NBP client and the position engine — none of which a watchlist listing has
 * any business loading. What is left here is a thin trio: the calendar, the
 * leaf reader and the pure grader.
 *
 * NEVER THROWS, and that is a contract rather than a courtesy: it joins the
 * `Promise.all` in `loadHoldingsInputs`, whose documented invariant is that
 * every member degrades internally. A trend is the least load-bearing thing
 * in either payload — a history outage must cost the strip and nothing else,
 * never the screen it sits on.
 *
 * The calendar read is inside the same guard for that reason. A failure there
 * yields no sessions, hence no strips, rather than a strip placed on guessed
 * weekdays — which is the failure mode `mark-sync.ts` already paid for once.
 *
 * An instrument whose every slot is a hole is ABSENT from the map rather than
 * present with five nulls: "no strip at all" and "five sessions we know
 * nothing about" render identically, and the smaller payload is the one worth
 * sending on every tile of a grid.
 */
export async function fetchTrendsBestEffort(
  instrumentIds: readonly string[],
): Promise<Map<string, TrendSlot[]>> {
  const trends = new Map<string, TrendSlot[]>();
  try {
    const { overrides } = await readStoredCalendar();
    const sessions = recentSessionDatesISO(TREND_SESSIONS_NEEDED, Date.now(), overrides);
    if (sessions.length < 2) return trends;

    for (const [instrumentId, closes] of await getRecentCloses(instrumentIds)) {
      const slots = toTrendDays(sessions, closes, EQUITY_TREND_SCALE);
      if (!isEmptyStrip(slots)) trends.set(instrumentId, slots);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'trend read failed';
    console.error(`Trend strips unavailable: ${message}`);
  }
  return trends;
}

/**
 * The same thing for option contracts, keyed by OCC ticker.
 *
 * A separate function rather than a `scale` parameter on the one above,
 * because the two differ in more than their bands: they read different tables,
 * key on different identifiers, and an option's valuations arrive already
 * merged from two sources with a tag saying which won. Folding that into one
 * function would mean a pile of flags whose combinations nobody exercises.
 *
 * Same never-throws contract, and for a sharper reason than the equity one:
 * this runs inside `loadOptionsInputs`, which the Options tab, the Dashboard
 * and the 60s poll all share. A trend outage must cost the strip, never the
 * tab.
 */
export async function fetchOptionTrendsBestEffort(
  tickers: readonly string[],
): Promise<Map<string, TrendSlot[]>> {
  const trends = new Map<string, TrendSlot[]>();
  try {
    const { overrides } = await readStoredCalendar();
    const sessions = recentSessionDatesISO(TREND_SESSIONS_NEEDED, Date.now(), overrides);
    if (sessions.length < 2) return trends;

    for (const [ticker, points] of await getRecentOptionValuations(tickers, sessions)) {
      const slots = toTrendDays(sessions, points, OPTION_TREND_SCALE);
      if (!isEmptyStrip(slots)) trends.set(ticker, slots);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'option trend read failed';
    console.error(`Option trend strips unavailable: ${message}`);
  }
  return trends;
}

/**
 * The whole holdings book's strip, in PLN — the Dashboard's "Total value"
 * box (2026-09-21). Same never-throws contract and the same session
 * calendar as the per-tile strips; the arithmetic is `totalValuationPoints`.
 * Returns `undefined` (absent on the wire) when the strip would be all holes.
 */
export async function fetchHoldingsTotalTrendBestEffort(
  positions: readonly TotalPosition[],
): Promise<TrendSlot[] | undefined> {
  try {
    if (positions.length === 0) return undefined;
    const { overrides } = await readStoredCalendar();
    const sessions = recentSessionDatesISO(TREND_SESSIONS_NEEDED, Date.now(), overrides);
    if (sessions.length < 2) return undefined;

    const closes = await getRecentCloses(positions.map((position) => position.key));
    const fxByCurrency = new Map<string, ReadonlyMap<string, string>>();
    for (const currency of new Set(positions.map((position) => position.currency))) {
      if (currency === 'PLN') continue;
      fxByCurrency.set(currency, await getFxRatesForRange(currency, sessions[0], sessions[sessions.length - 1]));
    }
    const slots = toTrendDays(sessions, totalValuationPoints(sessions, positions, closes, fxByCurrency), EQUITY_TREND_SCALE);
    return isEmptyStrip(slots) ? undefined : slots;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'total trend read failed';
    console.error(`Holdings total trend unavailable: ${message}`);
    return undefined;
  }
}

/** The options book's strip, in USD, on the option bands — the "Options" total. */
export async function fetchOptionsTotalTrendBestEffort(
  positions: readonly TotalPosition[],
): Promise<TrendSlot[] | undefined> {
  try {
    if (positions.length === 0) return undefined;
    const { overrides } = await readStoredCalendar();
    const sessions = recentSessionDatesISO(TREND_SESSIONS_NEEDED, Date.now(), overrides);
    if (sessions.length < 2) return undefined;

    const valuations = await getRecentOptionValuations(positions.map((position) => position.key), sessions);
    const points = totalValuationPoints(sessions, positions, valuations, new Map(), { convert: false });
    const slots = toTrendDays(sessions, points, OPTION_TREND_SCALE);
    return isEmptyStrip(slots) ? undefined : slots;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'options total trend read failed';
    console.error(`Options total trend unavailable: ${message}`);
    return undefined;
  }
}
