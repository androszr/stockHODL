import 'server-only';

import type { MarketStripPayloadContract } from '@/lib/api/contracts/market-strip';
import { resolveRange, sliceLastSessions } from '@/lib/charts/ranges';
import { downsample, type ChartPoint } from '@/lib/charts/series';
import { tagSessionPhases } from '@/lib/charts/session-phase';
import { addDaysIso } from '@/lib/dates';
import { fetchMarketStatusBestEffort, fetchQuotesBestEffort } from '@/lib/holdings/live-view';
import { massiveProvider } from '@/lib/market-data/massive';
import { readStoredCalendar } from '@/lib/market-data/calendar-store';
import { nyDateISOAt, recentSessionDatesISO } from '@/lib/market-data/market-clock';
import { TREND_SESSIONS_NEEDED, isEmptyStrip, toTrendDays, type TrendSlot } from '@/lib/trend/day-trend';
import { EQUITY_TREND_SCALE } from '@/lib/trend/trend-scale';

import { composeMarketStrip, INDEX_PROXY_SYMBOLS } from './compose';
import { fetchFxTile } from './fx-load';

/**
 * The impure half of the Dashboard's index strip: quotes, market status and
 * one day-session spark per proxy, all best-effort.
 *
 * Everything here reuses the discipline that already exists —
 * `fetchQuotesBestEffort` for the batch (per-symbol degradation, one vendor
 * call), `fetchMarketStatusBestEffort` for a status that never throws, and
 * the intraday branch of `getInstrumentPriceSeries` as the pattern for the
 * spark. The fan-out is bounded at exactly three by construction: the symbol
 * set is `INDEX_PROXY_SYMBOLS`, a module constant with no parameter that
 * could widen it, and `massive.ts`'s 60 s in-process intraday cache means a
 * once-a-minute poll costs the vendor next to nothing.
 *
 * `refs` is deliberately NOT passed to `fetchQuotesBestEffort`: the durable
 * quote cache is keyed by instrument id and these three ETFs are nobody's
 * holding. The strip is a third parallel delivery — it must not widen the
 * holdings batch, the socket subscription or any stored row.
 */

/** Calendar slack in front of the 1D window so `resolveRange` never clamps. */
const ANCHOR_LOOKBACK_DAYS = 30;

/**
 * The REGULAR session's five-minute bars for one proxy, oldest first.
 *
 * Extended-hours bars are tagged and then DROPPED before the trailing session
 * is chosen, and that order is the whole point: while the market is closed
 * the remaining bars' last date is yesterday's completed regular session —
 * exactly the session the status-aware `dayPct` beside it describes. Slicing
 * first would pick "today" at 05:00 ET on the strength of pre-market bars
 * alone and then leave the spark empty.
 *
 * Never throws: a vendor failure yields `[]`, which the tile renders as a
 * reserved-but-empty line rather than a broken row.
 */
async function fetchSpark(symbol: string, todayISO: string): Promise<ChartPoint[]> {
  try {
    const resolved = resolveRange('1D', {
      today: todayISO,
      anchorDate: addDaysIso(todayISO, -ANCHOR_LOOKBACK_DAYS),
    });
    if (resolved === null || resolved.kind !== 'intraday') return [];

    const candles = await massiveProvider.getAggregates(symbol, {
      multiplier: resolved.multiplier,
      timespan: 'minute',
      from: String(resolved.fromMs),
      to: String(resolved.toMs),
    });
    if (candles.length === 0) return [];

    const points: ChartPoint[] = candles.map((candle) => ({ t: candle.t, v: candle.close }));
    const tagged = tagSessionPhases(points, await massiveProvider.getCalendarOverrides());
    const regularOnly = tagged.filter((point) => point.p === undefined);

    return downsample(sliceLastSessions(regularOnly, 1));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'spark fetch failed';
    console.error(`Market strip spark failed (${symbol}): ${message}`);
    return [];
  }
}

/** Calendar days of daily bars that surely contain six sessions. */
const TREND_LOOKBACK_DAYS = 14;

/**
 * One strip per proxy per SESSION LIST. The strip is graded on completed
 * sessions only (`recentSessionDatesISO`), so it cannot change until the
 * next close — while the Dashboard polls this loader once a minute and the
 * vendor's daily aggregates have no cache of their own (`massive.ts` caches
 * minute bars only). Keyed by the session list rather than a clock, so a
 * new session invalidates it exactly, and a failed fetch is never memoised.
 */
const indexTrendMemo = new Map<string, { sessionsKey: string; slots: TrendSlot[] | undefined }>();

/**
 * The proxy's five-session strip from its daily bars, on the NYSE calendar —
 * the same grader and bands as a held stock's tile. Never throws: a vendor
 * failure yields no strip, and the tile reserves the space.
 */
async function fetchIndexTrend(
  symbol: string,
  sessions: readonly string[],
  todayISO: string,
): Promise<TrendSlot[] | undefined> {
  if (sessions.length < 2) return undefined;
  const sessionsKey = sessions.join(',');
  const hit = indexTrendMemo.get(symbol);
  if (hit && hit.sessionsKey === sessionsKey) return hit.slots;
  try {
    const candles = await massiveProvider.getAggregates(symbol, {
      multiplier: 1,
      timespan: 'day',
      from: addDaysIso(todayISO, -TREND_LOOKBACK_DAYS),
      to: todayISO,
    });
    const points = candles.map((candle) => ({ asOf: nyDateISOAt(candle.t), close: candle.close }));
    const slots = toTrendDays(sessions, points, EQUITY_TREND_SCALE);
    const result = isEmptyStrip(slots) ? undefined : slots;
    indexTrendMemo.set(symbol, { sessionsKey, slots: result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'trend fetch failed';
    console.error(`Market strip trend failed (${symbol}): ${message}`);
    return undefined;
  }
}

export async function loadMarketStrip(): Promise<MarketStripPayloadContract> {
  const [{ quotes }, market] = await Promise.all([
    fetchQuotesBestEffort(INDEX_PROXY_SYMBOLS),
    fetchMarketStatusBestEffort(),
  ]);

  // Sequential, not `Promise.all`: the provider doctrine forbids fanning out
  // aggregates requests, and three cached calls cost nothing to await in turn.
  const todayISO = nyDateISOAt(Date.now());
  const sparkBySymbol = new Map<string, readonly ChartPoint[]>();
  for (const symbol of INDEX_PROXY_SYMBOLS) {
    sparkBySymbol.set(symbol, await fetchSpark(symbol, todayISO));
  }

  // The strips ride the same sequential lane: one daily-bars call per proxy,
  // graded against the real session calendar like every holding's tile.
  const trendBySymbol = new Map<string, TrendSlot[]>();
  let sessions: string[] = [];
  try {
    sessions = recentSessionDatesISO(TREND_SESSIONS_NEEDED, Date.now(), (await readStoredCalendar()).overrides);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'calendar read failed';
    console.error(`Market strip trend calendar failed: ${message}`);
  }
  for (const symbol of INDEX_PROXY_SYMBOLS) {
    const slots = await fetchIndexTrend(symbol, sessions, todayISO);
    if (slots) trendBySymbol.set(symbol, slots);
  }

  // The currency tile last, still sequential: two more aggregates calls
  // (minute + daily) against `C:USDPLN`, which never enters the snapshot
  // batch above — see `fx-load.ts`.
  const fx = await fetchFxTile();

  return composeMarketStrip(quotes, sparkBySymbol, market, fx, trendBySymbol);
}
