import 'server-only';

import type { MarketTileKey } from '@/lib/api/contracts/market-strip';
import { resolveRange, type ChartRange } from '@/lib/charts/ranges';
import { downsample, emptySeries, type ChartPoint, type SeriesPayload } from '@/lib/charts/series';
import { getInstrumentPriceSeries } from '@/lib/history/portfolio-series';
import { resolveInstrumentForBrowsing } from '@/lib/instruments/resolve';
import { massiveProvider } from '@/lib/market-data/massive';
import { nyDateISOAt } from '@/lib/market-data/market-clock';
import { watchedAnchorDate } from '@/lib/watchlist/anchor';

import { indexProxyFor } from './compose';
import { FX_TICKER, sliceLastUtcDays, utcDateISOAt } from './fx';

/**
 * The chart behind a market tile — `/api/mobile/v1/market-strip/series/[key]`.
 *
 * The key is a CLOSED enum, validated by the handler before this runs, and
 * that closure is the whole reason this is not an open symbol proxy: there is
 * no string here that reaches the vendor or the database except the four the
 * enum names. `userPriceSeriesBySymbol` is deliberately NOT reused — it
 * resolves whatever symbol it is handed, which is exactly what this door must
 * not do.
 *
 * Two paths, because the two kinds of tile are two kinds of instrument:
 *
 * - An INDEX key (SPY/QQQ/DIA) charts exactly like a browsed stock —
 *   `resolveInstrumentForBrowsing` (a lazy mint from the vendor directory,
 *   first-write-wins name, the same row the strip's quote is not stored under)
 *   then `getInstrumentPriceSeries` with the fixed 5-year watched anchor: the
 *   cached daily history, the forming-day overlay and the 1D phase bands, for
 *   free and identically. Never the user's own trade anchor: a tile is about
 *   the index, not about a position somebody may happen to hold in the ETF.
 *
 * - The CURRENCY key bypasses the `instruments` table entirely. No row is
 *   minted for a currency (its `currency` column would say USD for a rate
 *   quoted in PLN — a lie the holdings engine would one day believe), and its
 *   daily bars are NOT stored in `price_snapshots`; they are fetched from the
 *   vendor per request, and the phone's `DiskCache` per key/range is the
 *   cache. Intraday ranges slice by UTC day (`sliceLastUtcDays`) — never
 *   `sliceLastSessions`, never `tagSessionPhases`, both of which cut a
 *   24-hour market at New York midnight and would shade it with New York
 *   bands. No `p` tags are set, so the phone draws no bands.
 *
 * Any throw degrades to the empty payload — the series refusal shape, never
 * a 404 and never an error body.
 */
export async function marketStripSeries(
  key: MarketTileKey,
  range: ChartRange,
): Promise<SeriesPayload> {
  try {
    if (key === 'USDPLN') return await fxSeries(range);

    const proxy = indexProxyFor(key);
    if (proxy === null) return emptySeries();

    const instrument = await resolveInstrumentForBrowsing(proxy.proxySymbol);
    if (!instrument) return emptySeries();

    return await getInstrumentPriceSeries(
      { id: instrument.id, symbol: instrument.symbol, currency: instrument.currency },
      watchedAnchorDate(nyDateISOAt(Date.now())),
      range,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'market series failed';
    console.error(`Market strip series failed (${key}, ${range}): ${message}`);
    return emptySeries();
  }
}

/**
 * The USD/PLN chart at one range. UTC-dated throughout (see `fx.ts`): the
 * anchor is the same 5-year policy a watched stock takes, applied to the UTC
 * date rather than the New York one, so `ALL` charts five years.
 */
async function fxSeries(range: ChartRange): Promise<SeriesPayload> {
  const today = utcDateISOAt(Date.now());
  const anchorDate = watchedAnchorDate(today);
  const resolved = resolveRange(range, { today, anchorDate });
  if (resolved === null) return emptySeries();

  if (resolved.kind === 'daily') {
    const candles = await massiveProvider.getAggregates(FX_TICKER, {
      multiplier: 1,
      timespan: 'day',
      from: resolved.from,
      to: resolved.to,
    });
    const points: ChartPoint[] = candles.map((candle) => ({
      t: candle.t,
      v: candle.close,
      o: candle.open,
      h: candle.high,
      l: candle.low,
    }));
    return { points: downsample(points), partialDays: 0, excludedSymbols: [], anchorDate };
  }

  const candles = await massiveProvider.getAggregates(FX_TICKER, {
    multiplier: resolved.multiplier,
    timespan: 'minute',
    from: String(resolved.fromMs),
    to: String(resolved.toMs),
  });
  const points: ChartPoint[] = candles.map((candle) => ({
    t: candle.t,
    v: candle.close,
    o: candle.open,
    h: candle.high,
    l: candle.low,
  }));
  return {
    points: downsample(sliceLastUtcDays(points, resolved.sessions)),
    partialDays: 0,
    excludedSymbols: [],
    anchorDate,
  };
}
