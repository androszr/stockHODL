import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Associated Domains file. What matters is not that it returns JSON, but
 * that it returns the SHAPE iOS accepts — Apple's fetcher does not report an
 * error, it just declines to form the association, so a wrong body here would
 * surface much later as "Face ID does nothing" in stage C1.
 */

const h = vi.hoisted(() => ({ env: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: h.env }));

import { GET } from './route';

beforeEach(() => {
  h.env.mockReset();
});

describe('/.well-known/apple-app-site-association', () => {
  it('publishes the app identifier under webcredentials', async () => {
    h.env.mockReturnValue({ APPLE_APP_ID: 'ABCDE12345.com.robertandrosz.stockhodl' });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual({
      webcredentials: { apps: ['ABCDE12345.com.robertandrosz.stockhodl'] },
    });
  });

  it('claims no applinks — the app must not hijack the web app’s URLs', async () => {
    h.env.mockReturnValue({ APPLE_APP_ID: 'ABCDE12345.com.robertandrosz.stockhodl' });

    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['webcredentials']);
  });

  it('404s while no Team ID is configured', async () => {
    // Not an error state: before enrollment completes there genuinely is no
    // app associated with this domain, and an empty `apps` list would be
    // cached by Apple as a valid answer meaning the same thing, but stickier.
    h.env.mockReturnValue({ APPLE_APP_ID: undefined });

    const response = await GET();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not configured.' });
  });
});
