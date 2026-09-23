import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tile-series door. The guard that matters most is the third case: a key
 * outside the closed enum answers the empty payload WITHOUT the series
 * function running — no vendor call, no instrument resolve, nothing that
 * could turn this route into an open chart proxy.
 */

const h = vi.hoisted(() => ({
  sessionUserId: vi.fn(),
  marketStripSeries: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api/mobile/session', () => ({ sessionUserId: h.sessionUserId }));
vi.mock('@/lib/market-strip/series', () => ({ marketStripSeries: h.marketStripSeries }));

import { emptySeries } from '@/lib/charts/series';

import { GET } from './route';

function call(key: string, range = '1D') {
  const request = new Request(
    `http://localhost/api/mobile/v1/market-strip/series/${encodeURIComponent(key)}?range=${range}`,
  );
  return GET(request, { params: Promise.resolve({ key }) });
}

const SERIES = {
  points: [{ t: 1_758_400_000_000, v: '3.7955' }],
  partialDays: 0,
  excludedSymbols: [],
  anchorDate: '2021-09-21',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.sessionUserId.mockResolvedValue('user-1');
  h.marketStripSeries.mockResolvedValue(SERIES);
});

describe('GET /api/mobile/v1/market-strip/series/[key]', () => {
  it('401s without a session and never charts', async () => {
    h.sessionUserId.mockResolvedValue(null);

    const response = await call('USDPLN');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Not signed in.' });
    expect(h.marketStripSeries).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('400s a range the app does not have', async () => {
    const response = await call('USDPLN', '3M');

    expect(response.status).toBe(400);
    expect(h.marketStripSeries).not.toHaveBeenCalled();
  });

  it.each(['AAPL', 'C:USDPLN', 'I:SPX', ''])(
    'answers the empty payload for %j with the series function uncalled',
    async (key) => {
      const response = await call(key);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(emptySeries());
      expect(h.marketStripSeries).not.toHaveBeenCalled();
    },
  );

  it('answers the empty payload for a malformed percent sequence instead of throwing', async () => {
    const request = new Request('http://localhost/api/mobile/v1/market-strip/series/%zz?range=1D');
    const response = await GET(request, { params: Promise.resolve({ key: '%zz' }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(emptySeries());
    expect(h.marketStripSeries).not.toHaveBeenCalled();
  });

  it('normalises a lowercase key into the enum', async () => {
    const response = await call('usdpln', '5D');

    expect(response.status).toBe(200);
    expect(h.marketStripSeries).toHaveBeenCalledExactlyOnceWith('USDPLN', '5D');
  });

  it('charts a known key at the parsed range and answers private, no-store', async () => {
    const response = await call('USDPLN', '1D');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SERIES);
    expect(h.marketStripSeries).toHaveBeenCalledExactlyOnceWith('USDPLN', '1D');
    const cache = response.headers.get('Cache-Control') ?? '';
    expect(cache).toContain('private');
    expect(cache).toContain('no-store');
  });

  it('routes an index key too', async () => {
    await call('SPY', '1Y');

    expect(h.marketStripSeries).toHaveBeenCalledExactlyOnceWith('SPY', '1Y');
  });
});
