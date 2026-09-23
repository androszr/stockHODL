import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the Massive adapter's calendar-state cache with every
 * boundary mocked out (the pattern of `portfolios/actions.test.ts`): env,
 * the calendar store, the stream module and global `fetch`. What is real:
 * `getCalendarState`'s cache ladder — specifically that a VENDOR-DOWN
 * fallback is cached under the degraded TTL (2026-08-14 fix) instead of
 * re-running the store reads plus a doomed fetch on every quote poll, and
 * that the failure is never cached beyond that TTL, so recovery is not
 * delayed.
 *
 * `calendarCache` is module-level state, so every test gets a fresh module
 * instance via `vi.resetModules()` + a dynamic import.
 */

const h = vi.hoisted(() => ({
  readStoredCalendar: vi.fn(),
  persistFetchedCalendar: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: () => ({ STOCK_API: 'test-key' }) }));
vi.mock('./calendar-store', () => ({
  readStoredCalendar: h.readStoredCalendar,
  persistFetchedCalendar: h.persistFetchedCalendar,
}));
vi.mock('./massive-stream', () => ({ streamPrices: vi.fn() }));

const fetchMock = vi.fn();

// Pay the module's cold TRANSFORM once, here at collection time, outside
// every test's timeout. Each test below still gets a fresh instance through
// `vi.resetModules()` + import, but that is now only a re-evaluation of an
// already-transformed module — so a loaded machine can no longer spend a
// test's 5 s budget compiling the file under test.
await import('./massive');

async function freshProvider() {
  vi.resetModules();
  const { massiveProvider } = await import('./massive');
  return massiveProvider;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  // Vendor down: every calendar fetch fails at the network level.
  fetchMock.mockRejectedValue(new Error('vendor unreachable'));
  h.readStoredCalendar.mockResolvedValue({
    ok: true,
    overrides: [],
    knownFromISO: '2020-01-01',
  });
  h.persistFetchedCalendar.mockResolvedValue(true);
  // Keep the vendor-down console.error noise out of the test output.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('checkKeyHealth — classification, never a throw', () => {
  it('a 2xx answer is ok', async () => {
    const provider = await freshProvider();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ market: 'closed' }), { status: 200 }),
    );
    await expect(provider.checkKeyHealth()).resolves.toBe('ok');
  });

  it.each([401, 403])('HTTP %d is unauthorized — the key itself is rejected', async (status) => {
    const provider = await freshProvider();
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(provider.checkKeyHealth()).resolves.toBe('unauthorized');
  });

  it('a timeout is unreachable', async () => {
    const provider = await freshProvider();
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    );
    await expect(provider.checkKeyHealth()).resolves.toBe('unreachable');
  });

  it('a 5xx is unreachable — the vendor is broken, not the key', async () => {
    const provider = await freshProvider();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(provider.checkKeyHealth()).resolves.toBe('unreachable');
  });
});

describe('isServablePublisherAssetUrl — the feed-side servability pre-check (2026-08-16 gap fix)', () => {
  async function freshPredicate() {
    vi.resetModules();
    const { isServablePublisherAssetUrl } = await import('./massive');
    return isServablePublisherAssetUrl;
  }

  it('accepts a raster path on either fetchable origin', async () => {
    const servable = await freshPredicate();
    expect(servable('https://s3.massive.com/public/assets/news/benzinga.png')).toBe(true);
    expect(servable('https://api.massive.com/v1/reference/publisher/favicon.ico')).toBe(true);
  });

  it('rejects an svg path — the regression: hasPublisherLogo must not promise an image the proxy refuses by design', async () => {
    const servable = await freshPredicate();
    expect(servable('https://s3.massive.com/public/assets/news/benzinga-logo.svg')).toBe(false);
    // Case-insensitive, and the PATH decides — a query string hides nothing.
    expect(servable('https://s3.massive.com/public/assets/news/logo.SVG')).toBe(false);
    expect(servable('https://s3.massive.com/public/assets/news/logo.svg?v=2')).toBe(false);
  });

  it('rejects null and any third origin — mirrors the route, which never fetches toward a third host', async () => {
    const servable = await freshPredicate();
    expect(servable(null)).toBe(false);
    expect(servable('https://cdn.example.com/logo.png')).toBe(false);
    // Prefix trickery: origin must match at a path boundary.
    expect(servable('https://s3.massive.com.evil.example/logo.png')).toBe(false);
  });
});

describe('getMarketStatus — TTL cache', () => {
  /** Count only the status-now fetches — the calendar fetch shares the mock. */
  const nowCalls = () =>
    fetchMock.mock.calls.filter((call) => String(call[0]).includes('/v1/marketstatus/now')).length;

  /**
   * URL-discriminating fetch: the upcoming calendar always answers (empty
   * array — a valid body, so the calendar cache stays healthy and out of the
   * way), and `/v1/marketstatus/now` goes through the per-test handler.
   */
  function mockVendor(nowHandler: () => Promise<Response>) {
    fetchMock.mockImplementation((url: unknown) => {
      const target = String(url);
      if (target.includes('/v1/marketstatus/upcoming')) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (target.includes('/v1/marketstatus/now')) return nowHandler();
      return Promise.reject(new Error(`unexpected fetch: ${target}`));
    });
  }

  it('serves the cache inside 30 s — exactly one status fetch for two calls', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Friday, 12:00 UTC — the next scheduled boundary (13:30 UTC open) is
    // far beyond the TTL, so the cap cannot interfere with this case.
    vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
    const provider = await freshProvider();
    mockVendor(() =>
      Promise.resolve(new Response(JSON.stringify({ market: 'open' }), { status: 200 })),
    );

    const first = await provider.getMarketStatus();
    vi.setSystemTime(new Date('2026-08-14T12:00:10Z'));
    const second = await provider.getMarketStatus();

    expect(first.status).toBe('open');
    expect(second).toEqual(first);
    expect(nowCalls()).toBe(1);
  });

  it('re-asks after the 30 s TTL lapses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
    const provider = await freshProvider();
    mockVendor(() =>
      Promise.resolve(new Response(JSON.stringify({ market: 'open' }), { status: 200 })),
    );

    await provider.getMarketStatus();
    vi.setSystemTime(new Date('2026-08-14T12:00:31Z'));
    await provider.getMarketStatus();

    expect(nowCalls()).toBe(2);
  });

  it('expiry is capped at a scheduled transition: a call seconds after the bell refetches and reports the new phase', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Monday 2026-08-17, 13:29:50 UTC = 09:29:50 ET — ten seconds before the
    // regular open. A naive 30 s TTL would serve pre-market until 13:30:20.
    vi.setSystemTime(new Date('2026-08-17T13:29:50Z'));
    const provider = await freshProvider();
    let phase: Record<string, unknown> = { earlyHours: true };
    mockVendor(() => Promise.resolve(new Response(JSON.stringify(phase), { status: 200 })));

    const before = await provider.getMarketStatus();
    expect(before.status).toBe('early_trading');

    // 13:30:05 — inside 30 s of the first call, but past the boundary the
    // entry was capped at. The vendor now says open; the cache must not.
    phase = { market: 'open' };
    vi.setSystemTime(new Date('2026-08-17T13:30:05Z'));
    const after = await provider.getMarketStatus();

    expect(after.status).toBe('open');
    expect(nowCalls()).toBe(2);
  });

  it('a vendor-down (clock-derived) answer is re-asked after 10 s, not 30', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
    const provider = await freshProvider();
    mockVendor(() => Promise.reject(new Error('vendor unreachable')));

    const degraded = await provider.getMarketStatus();
    // The fallback is the pure clock — 08:00 ET on a weekday is pre-market.
    expect(degraded.status).toBe('early_trading');

    // 5 s later: still inside the degraded TTL — served from cache.
    vi.setSystemTime(new Date('2026-08-14T12:00:05Z'));
    await provider.getMarketStatus();
    expect(nowCalls()).toBe(1);

    // 11 s after the failure: past the 10 s degraded TTL — re-asked, so
    // recovery is never delayed by the healthy 30 s window.
    vi.setSystemTime(new Date('2026-08-14T12:00:11Z'));
    await provider.getMarketStatus();
    expect(nowCalls()).toBe(2);
  });
});

describe('getCalendarState — vendor-down degraded cache', () => {
  it('caches the vendor-down state: the immediate next call reads neither the store nor the vendor', async () => {
    const provider = await freshProvider();

    await provider.getCalendarOverrides();
    await provider.getCalendarOverrides();

    // Without the 2026-08-14 fix the failure state was never cached, so the
    // second call re-ran both — these would each be 2.
    expect(h.readStoredCalendar).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('…but not for long: past the 60 s degraded TTL the vendor is re-asked, so recovery is not delayed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
    const provider = await freshProvider();

    await provider.getCalendarOverrides();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 61 s later — the degraded TTL (60 s) has lapsed. Were the failure held
    // under the healthy 6 h TTL instead, this would still serve the cache.
    vi.setSystemTime(new Date('2026-08-14T12:01:01Z'));
    await provider.getCalendarOverrides();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
