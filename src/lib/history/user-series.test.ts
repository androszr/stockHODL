import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unique cases that used to live next to the chart Server Actions: scope
 * fallback to all-portfolios, instrument-anchor vs first trade, foreign
 * instrument → empty payload. Driven at `userPortfolioSeries` /
 * `userPriceSeries` with a user id, not a session wrapper.
 */

const h = vi.hoisted(() => ({
  firstTradeDate: vi.fn(),
  watchlistWhere: vi.fn(),
  getPortfolioValueSeries: vi.fn(),
  getInstrumentPriceSeries: vi.fn(),
  resolvePortfolioScope: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: h.watchlistWhere,
        })),
      })),
    })),
  },
  instruments: { id: 'id', symbol: 'symbol', currency: 'currency' },
  watchlist: { userId: 'user_id', instrumentId: 'instrument_id' },
}));
vi.mock('@/lib/holdings/scope', () => ({ resolvePortfolioScope: h.resolvePortfolioScope }));
vi.mock('@/lib/history/portfolio-series', () => ({
  getPortfolioValueSeries: h.getPortfolioValueSeries,
  getInstrumentPriceSeries: h.getInstrumentPriceSeries,
}));
vi.mock('@/lib/transactions/mutations', () => ({ firstTradeDate: h.firstTradeDate }));
vi.mock('@/lib/instruments/resolve', () => ({ resolveInstrumentForBrowsing: vi.fn() }));

import { emptySeries } from '@/lib/charts/series';
import { instrumentAnchorDate } from '@/lib/history/anchor';
import { userPortfolioSeries, userPriceSeries } from '@/lib/history/user-series';
import { nyDateISOAt } from '@/lib/market-data/market-clock';

const INSTRUMENT_ID = '9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f';
const EMPTY = emptySeries();

beforeEach(() => {
  vi.clearAllMocks();
  h.resolvePortfolioScope.mockResolvedValue(null);
  h.watchlistWhere.mockResolvedValue([]);
});

describe('userPortfolioSeries', () => {
  it('scopes the series to a portfolio the resolver vouched for', async () => {
    h.resolvePortfolioScope.mockResolvedValue('portfolio-1');
    h.getPortfolioValueSeries.mockResolvedValue({ ...EMPTY, anchorDate: '2026-01-02' });

    await userPortfolioSeries('user-1', '1M', 'portfolio-1');

    expect(h.resolvePortfolioScope).toHaveBeenCalledWith('user-1', 'portfolio-1');
    expect(h.getPortfolioValueSeries).toHaveBeenCalledExactlyOnceWith(
      'user-1',
      '1M',
      'portfolio-1',
    );
  });

  it('falls back to the all-portfolios series when the scope is refused', async () => {
    // A foreign, malformed or deleted id resolves to null — the answer is the
    // unscoped series, never an error and never another user's rows.
    h.resolvePortfolioScope.mockResolvedValue(null);
    h.getPortfolioValueSeries.mockResolvedValue({ ...EMPTY, anchorDate: null });

    await userPortfolioSeries('user-1', '1M', 'not-mine');

    expect(h.getPortfolioValueSeries).toHaveBeenCalledExactlyOnceWith('user-1', '1M', undefined);
  });
});

describe('userPriceSeries', () => {
  it('a foreign instrument (no owned transactions, not watched) degrades to empty, no series build', async () => {
    h.firstTradeDate.mockResolvedValue(null);
    h.watchlistWhere.mockResolvedValue([]);

    await expect(userPriceSeries('user-1', INSTRUMENT_ID, '1M')).resolves.toEqual(EMPTY);
    expect(h.getInstrumentPriceSeries).not.toHaveBeenCalled();
  });

  it('an owned instrument anchors at the INSTRUMENT anchor, not the first trade', async () => {
    // 2026-08-20: a price chart is about the instrument, so a trade inside the
    // five-year floor widens down to that floor — the same window the same
    // stock gets when it is merely watched.
    h.firstTradeDate.mockResolvedValue({
      symbol: 'AAPL',
      currency: 'USD',
      tradeDate: '2024-05-01',
    });
    h.getInstrumentPriceSeries.mockResolvedValue({ ...EMPTY, anchorDate: '2024-05-01' });

    await userPriceSeries('user-1', INSTRUMENT_ID, '5Y');

    expect(h.getInstrumentPriceSeries).toHaveBeenCalledExactlyOnceWith(
      { id: INSTRUMENT_ID, symbol: 'AAPL', currency: 'USD' },
      instrumentAnchorDate(nyDateISOAt(Date.now()), '2024-05-01'),
      '5Y',
    );
  });

  it('keeps a first trade OLDER than the floor as the anchor', async () => {
    h.firstTradeDate.mockResolvedValue({
      symbol: 'AAPL',
      currency: 'USD',
      tradeDate: '2015-03-04',
    });
    h.getInstrumentPriceSeries.mockResolvedValue(EMPTY);

    await userPriceSeries('user-1', INSTRUMENT_ID, '5Y');

    expect(h.getInstrumentPriceSeries).toHaveBeenCalledExactlyOnceWith(
      { id: INSTRUMENT_ID, symbol: 'AAPL', currency: 'USD' },
      '2015-03-04',
      '5Y',
    );
  });
});
