import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/options/live-view', () => ({ loadOptionsInputs: vi.fn() }));
vi.mock('@/lib/options/portfolio-series', () => ({ loadUserOptionLots: vi.fn() }));
vi.mock('@/lib/options/recent-valuations', () => ({ getRecentOptionValuations: vi.fn() }));

import type { OptionPositionRow } from '@/lib/options/options-payload';
import type { DividendEvent } from '@/lib/market-data/provider';
import { loadVendorDividendEvents } from './events';
import { optionExpiriesInWeek } from './options-loader';

const lot = (expirationDate: string, tradeDate = '2026-09-01'): OptionPositionRow => ({
  id: expirationDate, ticker: `O:${expirationDate}`, underlying: 'AAPL', contractType: 'call',
  strikePrice: '100', expirationDate, sharesPerContract: '100', quantity: '1', entryPrice: '1', tradeDate, fees: '0',
});

describe('day report events', () => {
  it('includes an expiry later in the same week', () => expect(optionExpiriesInWeek([lot('2026-09-25')], '2026-09-21')).toHaveLength(1));
  it('excludes the next-week expiry', () => expect(optionExpiriesInWeek([lot('2026-09-28')], '2026-09-21')).toHaveLength(0));
  it('excludes a lot bought after the report day', () => expect(optionExpiriesInWeek([lot('2026-09-25', '2026-09-22')], '2026-09-21')).toHaveLength(0));

  it('bounds dividend vendor fan-out and keeps all successful events', async () => {
    let active = 0;
    let maxActive = 0;
    const symbols = Array.from({ length: 12 }, (_, index) => `S${index}`);
    const load = vi.fn(async (symbol: string): Promise<DividendEvent[]> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return [{
        vendorId: symbol, cashAmount: '1.25', currency: 'USD', exDate: '2026-09-21',
        payDate: null, recordDate: null, declarationDate: null, frequency: null,
      }];
    });

    const events = await loadVendorDividendEvents(symbols, '2026-09-21', load);

    expect(maxActive).toBe(5);
    expect(events).toHaveLength(12);
  });
});
