import 'server-only';

import { loadOptionsInputs } from '@/lib/options/live-view';
import {
  composeOptionLotContributions,
  type OptionPositionRow,
} from '@/lib/options/options-payload';
import { loadUserOptionLots } from '@/lib/options/portfolio-series';
import { getRecentOptionValuations } from '@/lib/options/recent-valuations';

import type { FigureSource } from './source';

export type LoadedDayOptions =
  | {
      status: 'ready';
      lots: OptionPositionRow[];
      valuationsByTickerDate: Map<string, string>;
      contributions: ReturnType<typeof composeOptionLotContributions>;
    }
  | { status: 'unavailable' };

export async function loadOptionsForDay(
  userId: string,
  dayISO: string,
  source: FigureSource,
  prevSession: string,
  nowMs: number,
): Promise<LoadedDayOptions> {
  try {
    if (source === 'live') {
      const loaded = await loadOptionsInputs(userId);
      return {
        status: 'ready',
        lots: loaded.rows,
        valuationsByTickerDate: new Map(),
        contributions: composeOptionLotContributions(loaded, nowMs),
      };
    }

    const lots = await loadUserOptionLots(userId);
    const tickers = [...new Set(lots.map((lot) => lot.ticker))];
    // This reader delegates the recorded-mark-over-close precedence to
    // `mergeOptionValuations`; the report never invents its own merge rule.
    const rows = await getRecentOptionValuations(tickers, [prevSession, dayISO]);
    const valuationsByTickerDate = new Map<string, string>();
    for (const [ticker, points] of rows) {
      for (const point of points) valuationsByTickerDate.set(`${ticker}|${point.asOf}`, point.close);
    }
    return { status: 'ready', lots, valuationsByTickerDate, contributions: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'option day report failed';
    console.error(`Day report options failed: ${message}`);
    return { status: 'unavailable' };
  }
}

export function optionExpiriesInWeek(
  lots: readonly OptionPositionRow[],
  dayISO: string,
): OptionPositionRow[] {
  const day = new Date(`${dayISO}T12:00:00Z`);
  const daysToFriday = (5 - day.getUTCDay() + 7) % 7;
  const friday = new Date(day.getTime() + daysToFriday * 86_400_000).toISOString().slice(0, 10);
  return lots.filter(
    (lot) => lot.tradeDate <= dayISO && lot.expirationDate >= dayISO && lot.expirationDate <= friday,
  );
}
