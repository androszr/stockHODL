import 'server-only';

import type { ChartPoint } from '@/lib/charts/series';
import { downsample } from '@/lib/charts/series';
import { resolveRange } from '@/lib/charts/ranges';
import {
  buildDailyPortfolioSeries,
  buildIntradayPortfolioSeries,
  loadIntradayCandles,
  MAX_INTRADAY_SYMBOLS,
} from '@/lib/history/portfolio-series';
import { getLatestClosesBefore } from '@/lib/history/price-history';
import {
  nyDateISOAt,
  recentSessionDatesISO,
  type CalendarOverride,
} from '@/lib/market-data/market-clock';
import type { EngineTransaction } from '@/lib/position-engine';

import type { FigureSource } from './source';

export interface DayValueLine {
  kind: 'intraday' | 'daily' | 'none';
  points: ChartPoint[];
  windowLabel: string | null;
  partialDays: number;
  excludedSymbols: string[];
}

export async function dayValueLine(
  txs: readonly EngineTransaction[],
  dayISO: string,
  _source: FigureSource,
  overrides: readonly CalendarOverride[],
  closesByInstrument: ReadonlyMap<string, ReadonlyMap<string, string>>,
  fxByCurrency: ReadonlyMap<string, ReadonlyMap<string, string>>,
): Promise<DayValueLine> {
  if (txs.length === 0) {
    return { kind: 'none', points: [], windowLabel: null, partialDays: 0, excludedSymbols: [] };
  }
  const refs = [...new Map(txs.map((tx) => [
    tx.instrumentId,
    { id: tx.instrumentId, symbol: tx.symbol, currency: tx.currency },
  ])).values()];
  const anchorDate = txs.map((tx) => tx.tradeDate).sort()[0] ?? null;
  if (
    refs.length <= MAX_INTRADAY_SYMBOLS
    && recentSessionDatesISO(10, Date.now(), overrides).includes(dayISO)
  ) {
    const resolved = resolveRange('1D', { today: dayISO, anchorDate });
    if (resolved?.kind === 'intraday') {
      const loaded = await loadIntradayCandles(refs, resolved);
      const candlesByInstrument = new Map(
        [...loaded].map(([id, candles]) => [
          id,
          candles.filter((candle) => nyDateISOAt(candle.t) === dayISO),
        ]),
      );
      const usdIds = refs.filter((ref) => ref.currency === 'USD').map((ref) => ref.id);
      const fxRateByCurrency = new Map<string, string>();
      for (const currency of new Set(refs.map((ref) => ref.currency))) {
        const rate = fxByCurrency.get(currency)?.get(dayISO);
        if (rate !== undefined) fxRateByCurrency.set(currency, rate);
      }
      const built = buildIntradayPortfolioSeries({
        txs: [...txs],
        candlesByInstrument,
        sessions: 1,
        fxRateByCurrency,
        baselineCloseByInstrument: await getLatestClosesBefore(usdIds, dayISO),
        sessionOverrides: overrides,
        window: { from: dayISO, to: dayISO },
      });
      if (built.points.length > 0) {
        return {
          kind: 'intraday',
          points: downsample(built.points),
          windowLabel: dayISO,
          partialDays: built.partialDays,
          excludedSymbols: built.excludedSymbols,
        };
      }
    }
  }
  const earliest = [...closesByInstrument.values()]
    .flatMap((closes) => [...closes.keys()])
    .filter((day) => day <= dayISO)
    .sort()[0];
  if (earliest === undefined) {
    return { kind: 'none', points: [], windowLabel: null, partialDays: 0, excludedSymbols: [] };
  }
  const built = buildDailyPortfolioSeries({
    txs: [...txs],
    closesByInstrument,
    fxByCurrency,
    window: { from: earliest, to: dayISO },
  });
  return {
    kind: built.points.length === 0 ? 'none' : 'daily',
    points: downsample(built.points),
    windowLabel: built.points.length === 0 ? null : `Sessions to ${dayISO}`,
    partialDays: built.partialDays,
    excludedSymbols: built.excludedSymbols,
  };
}
