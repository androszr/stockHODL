import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The USD/PLN tile's loader under the vendor's currency rate limit
 * (2026-09-28): production answered `HTTP 429` whenever the phone sent a
 * burst of strip requests, and every 429 blanked the tile. The adapter is
 * mocked; the subject is how often it is called and what a failure returns.
 */
vi.mock('server-only', () => ({}));
const getAggregates = vi.fn();
vi.mock('@/lib/market-data/massive', () => ({ massiveProvider: { getAggregates } }));

const { fetchFxTile, resetFxHeldBarsForTests } = await import('./fx-load');

const DAY = 86_400_000;
const now = Date.UTC(2026, 8, 28, 18, 0);
const minuteBars = [
  { t: now - 10 * 60_000, open: '3.84', high: '3.84', low: '3.84', close: '3.8400', volume: '1' },
  { t: now - 5 * 60_000, open: '3.84', high: '3.85', low: '3.84', close: '3.8500', volume: '1' },
];
const dailyBars = [
  { t: Date.UTC(2026, 8, 26), open: '3.8', high: '3.8', low: '3.8', close: '3.8000', volume: '1' },
  { t: Date.UTC(2026, 8, 27), open: '3.8', high: '3.8', low: '3.8', close: '3.8200', volume: '1' },
];

function vendorAnswers() {
  getAggregates.mockImplementation(async (_symbol: string, spec: { timespan: string }) =>
    spec.timespan === 'day' ? dailyBars : minuteBars,
  );
}

function vendorRateLimits() {
  getAggregates.mockRejectedValue(new Error('Massive request failed: HTTP 429'));
}

beforeEach(() => {
  resetFxHeldBarsForTests();
  getAggregates.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('fetchFxTile', () => {
  it('draws the rate and the day move from the bars', async () => {
    vendorAnswers();
    const fx = await fetchFxTile();
    expect(fx.last).toBe('3,8500');
    expect(fx.dayPct?.text).toMatch(/^\+0,7/);
  });

  it('shares one vendor call per kind between a burst of concurrent requests', async () => {
    vendorAnswers();
    const all = await Promise.all([fetchFxTile(), fetchFxTile(), fetchFxTile(), fetchFxTile()]);
    expect(all.every((fx) => fx.last === '3,8500')).toBe(true);
    expect(getAggregates).toHaveBeenCalledTimes(2);
  });

  it('holds the daily bars far longer than the minute bars', async () => {
    vendorAnswers();
    await fetchFxTile();
    vi.setSystemTime(now + 2 * 60_000);
    await fetchFxTile();
    const specs = getAggregates.mock.calls.map(([, spec]) => spec.timespan);
    expect(specs).toEqual(['minute', 'day', 'minute']);
  });

  it('keeps the last good rate on screen when the vendor rate-limits', async () => {
    vendorAnswers();
    await fetchFxTile();
    vi.setSystemTime(now + 20 * 60_000);
    vendorRateLimits();
    const fx = await fetchFxTile();
    expect(fx.last).toBe('3,8500');
    expect(fx.dayPct).not.toBeNull();
  });

  it('goes blank only when nothing good is held, or what is held is too old', async () => {
    vendorRateLimits();
    expect((await fetchFxTile()).last).toBeNull();

    vendorAnswers();
    await fetchFxTile();
    vi.setSystemTime(now + DAY);
    vendorRateLimits();
    expect((await fetchFxTile()).last).toBeNull();
  });
});
