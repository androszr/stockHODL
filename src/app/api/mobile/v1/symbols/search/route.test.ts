import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Relocated unique e2e assertions for symbol search: no session → 401
 * `{ error: 'Not signed in.' }`, `Cache-Control` contains `private` and
 * `no-store`, body does not contain a ticker. The remaining door after the
 * web cookie twin is gone is this handler.
 */

const h = vi.hoisted(() => ({
  sessionUserId: vi.fn(),
  searchSymbols: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api/mobile/session', () => ({ sessionUserId: h.sessionUserId }));
vi.mock('@/lib/market-data/search', () => ({ searchSymbols: h.searchSymbols }));

import { GET } from './route';

function searchRequest(): Request {
  return new Request('http://localhost/api/mobile/v1/symbols/search?q=nike');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.searchSymbols.mockResolvedValue({
    results: [{ symbol: 'NKE', name: 'Nike, Inc.', exchange: 'NYSE' }],
    degraded: false,
  });
});

describe('GET /api/mobile/v1/symbols/search — unauthenticated', () => {
  it('401s without a session and never searches', async () => {
    h.sessionUserId.mockResolvedValue(null);

    const response = await GET(searchRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Not signed in.' });
    expect(h.searchSymbols).not.toHaveBeenCalled();
  });

  it('denied responses are never shared-cacheable', async () => {
    h.sessionUserId.mockResolvedValue(null);

    const response = await GET(searchRequest());
    const cache = response.headers.get('Cache-Control') ?? '';

    expect(cache).toContain('private');
    expect(cache).toContain('no-store');
  });

  it('no upstream symbol data leaks through the denial', async () => {
    h.sessionUserId.mockResolvedValue(null);

    const body = await (await GET(searchRequest())).text();

    expect(body).not.toContain('NKE');
    expect(body).not.toContain('Nike');
    expect(body).not.toContain('exchDisp');
  });
});
