import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The chart behind a market tile. What matters: an index key charts exactly
 * like a browsed stock with the FIXED 5-year anchor (never a trade anchor);
 * the currency key never touches the instruments table, slices by UTC day,
 * carries OHLC and no `p` tags; and every failure is the empty payload.
 */

const h = vi.hoisted(() => ({
  getAggregates: vi.fn(),
  resolveInstrumentForBrowsing: vi.fn(),
  getInstrumentPriceSeries: vi.fn(),
  firstTradeDate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/market-data/massive', () => ({
  massiveProvider: { getAggregates: h.getAggregates },
}));
vi.mock('@/lib/instruments/resolve', () => ({
  resolveInstrumentForBrowsing: h.resolveInstrumentForBrowsing,
}));
vi.mock('@/lib/history/portfolio-series', () => ({
  getInstrumentPriceSeries: h.getInstrumentPriceSeries,
}));
vi.mock('@/lib/transactions/mutations', () => ({ firstTradeDate: h.firstTradeDate }));

import { emptySeries } from '@/lib/charts/series';
import type { Candle } from '@/lib/market-data/provider';
import { nyDateISOAt } from '@/lib/market-data/market-clock';
import { watchedAnchorDate } from '@/lib/watchlist/anchor';

import { marketStripSeries } from './series';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Monday 2026-09-21 15:00 UTC — the clock every test runs at. */
const NOW = Date.UTC(2026, 8, 21, 15);

function candle(t: number, close: string): Candle {
  return { t, open: '3.70', high: '3.80', low: '3.69', close, volume: '0' };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.getAggregates.mockResolvedValue([]);
  h.getInstrumentPriceSeries.mockResolvedValue(emptySeries('2021-09-21'));
  h.resolveInstrumentForBrowsing.mockResolvedValue({
    id: 'spy-uuid',
    symbol: 'SPY',
    displayName: 'SPDR S&P 500 ETF Trust',
    exchange: 'NYSE Arca',
    currency: 'USD',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('marketStripSeries — index keys', () => {
  it('charts the proxy like a browsed stock, with the 5-year anchor and never a trade anchor', async () => {
    await marketStripSeries('SPY', '1Y');

    expect(h.resolveInstrumentForBrowsing).toHaveBeenCalledExactlyOnceWith('SPY');
    expect(h.getInstrumentPriceSeries).toHaveBeenCalledExactlyOnceWith(
      { id: 'spy-uuid', symbol: 'SPY', currency: 'USD' },
      watchedAnchorDate(nyDateISOAt(NOW)),
      '1Y',
    );
    expect(h.firstTradeDate).not.toHaveBeenCalled();
    // The currency's vendor path is never touched for an index key.
    expect(h.getAggregates).not.toHaveBeenCalled();
  });

  it('answers the empty payload when the proxy cannot be resolved', async () => {
    h.resolveInstrumentForBrowsing.mockResolvedValue(null);

    const payload = await marketStripSeries('QQQ', '1M');

    expect(payload).toEqual(emptySeries());
    expect(h.getInstrumentPriceSeries).not.toHaveBeenCalled();
  });

  it('answers the empty payload when the series throws', async () => {
    h.getInstrumentPriceSeries.mockRejectedValue(new Error('vendor down'));

    const payload = await marketStripSeries('DIA', '5Y');

    expect(payload).toEqual(emptySeries());
  });
});

describe('marketStripSeries — USDPLN', () => {
  it('never resolves an instrument and asks the vendor for a UTC-dated daily window', async () => {
    h.getAggregates.mockResolvedValue([
      candle(Date.UTC(2026, 7, 21), '3.6500'),
      candle(Date.UTC(2026, 8, 18), '3.7500'),
    ]);

    const payload = await marketStripSeries('USDPLN', '1M');

    expect(h.resolveInstrumentForBrowsing).not.toHaveBeenCalled();
    expect(h.getInstrumentPriceSeries).not.toHaveBeenCalled();
    expect(h.getAggregates).toHaveBeenCalledExactlyOnceWith('C:USDPLN', {
      multiplier: 1,
      timespan: 'day',
      from: '2026-08-21',
      to: '2026-09-21',
    });
    expect(payload.anchorDate).toBe(watchedAnchorDate('2026-09-21'));
    expect(payload.partialDays).toBe(0);
    expect(payload.excludedSymbols).toEqual([]);
    expect(payload.points.map((p) => p.v)).toEqual(['3.6500', '3.7500']);
  });

  it('1D is one UTC day of minute bars — not a New York session', async () => {
    const sun = Date.UTC(2026, 8, 20);
    const mon = Date.UTC(2026, 8, 21);
    h.getAggregates.mockResolvedValue([
      candle(sun + 22 * HOUR, '3.7600'),
      candle(sun + 23 * HOUR, '3.7650'),
      // 01:00 UTC Monday is still Sunday evening in New York; a NY-day slice
      // would glue it to the Sunday stub. UTC keeps it with Monday.
      candle(mon + HOUR, '3.7700'),
      candle(mon + 14 * HOUR, '3.7955'),
    ]);

    const payload = await marketStripSeries('USDPLN', '1D');

    const [spec] = h.getAggregates.mock.calls[0].slice(1);
    expect(spec.timespan).toBe('minute');
    expect(spec.multiplier).toBe(5);
    expect(payload.points.map((p) => p.t)).toEqual([mon + HOUR, mon + 14 * HOUR]);
  });

  it('5D is five UTC days of thirty-minute bars', async () => {
    const mon = Date.UTC(2026, 8, 21);
    const bars: Candle[] = [];
    for (let day = 8; day >= 0; day--) {
      bars.push(candle(mon - day * DAY + 10 * HOUR, `3.7${day}00`));
    }
    h.getAggregates.mockResolvedValue(bars);

    const payload = await marketStripSeries('USDPLN', '5D');

    const [spec] = h.getAggregates.mock.calls[0].slice(1);
    expect(spec.multiplier).toBe(30);
    expect(payload.points).toHaveLength(5);
    expect(payload.points[0].t).toBe(mon - 4 * DAY + 10 * HOUR);
  });

  it('points carry OHLC for the candle view and no session phase', async () => {
    h.getAggregates.mockResolvedValue([candle(Date.UTC(2026, 8, 18), '3.7500')]);

    const payload = await marketStripSeries('USDPLN', '6M');

    expect(payload.points[0]).toEqual({
      t: Date.UTC(2026, 8, 18),
      v: '3.7500',
      o: '3.70',
      h: '3.80',
      l: '3.69',
    });
    expect('p' in payload.points[0]).toBe(false);
  });

  it('a vendor throw is the empty payload, never an error', async () => {
    h.getAggregates.mockRejectedValue(new Error('NOT_ENTITLED'));

    const payload = await marketStripSeries('USDPLN', '1Y');

    expect(payload).toEqual(emptySeries());
  });

  it('every value on the wire is a decimal string', async () => {
    h.getAggregates.mockResolvedValue([candle(Date.UTC(2026, 8, 18), '3.7500')]);

    const payload = await marketStripSeries('USDPLN', 'ALL');

    for (const point of payload.points) {
      expect(typeof point.v).toBe('string');
      expect(typeof point.o).toBe('string');
      expect(typeof point.t).toBe('number');
    }
  });
});
