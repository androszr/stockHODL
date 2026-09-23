import { describe, expect, it } from 'vitest';

import { cronGate } from './gate';

/**
 * The scheduled jobs' only lock. Each case is a caller the internet can
 * produce; the gate must refuse every one of them except the exact bearer.
 */

const SECRET = 'a-cron-secret-of-at-least-16-chars';

function call(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('https://example.com/api/cron/refresh-symbols', { headers });
}

describe('cronGate — refusals', () => {
  it('answers 503 "Not configured." when the server has no secret, even for a bearer', async () => {
    const refused = cronGate(call(`Bearer ${SECRET}`), undefined);
    expect(refused?.status).toBe(503);
    expect(await refused?.json()).toEqual({ error: 'Not configured.' });
  });

  it('treats an empty configured secret as not configured, never as "match an empty header"', async () => {
    const refused = cronGate(call(''), '');
    expect(refused?.status).toBe(503);
    expect(await refused?.json()).toEqual({ error: 'Not configured.' });
  });

  it('answers 401 when the authorization header is missing', async () => {
    const refused = cronGate(call(), SECRET);
    expect(refused?.status).toBe(401);
    expect(await refused?.json()).toEqual({ error: 'Unauthorized.' });
  });

  it('answers 401 on an empty authorization header', () => {
    expect(cronGate(call(''), SECRET)?.status).toBe(401);
  });

  it('answers 401 on a wrong bearer', () => {
    expect(cronGate(call('Bearer not-the-secret'), SECRET)?.status).toBe(401);
  });

  it('answers 401 on the right token under the wrong scheme', () => {
    expect(cronGate(call(`Basic ${SECRET}`), SECRET)?.status).toBe(401);
    // The bare secret without any scheme is not the bearer either.
    expect(cronGate(call(SECRET), SECRET)?.status).toBe(401);
  });

  it('answers 401 on a bearer that only starts with the secret', () => {
    expect(cronGate(call(`Bearer ${SECRET}x`), SECRET)?.status).toBe(401);
    expect(cronGate(call(`Bearer ${SECRET.slice(0, -1)}`), SECRET)?.status).toBe(401);
  });

  it('never lets either refusal be cached', () => {
    for (const refused of [cronGate(call(), undefined), cronGate(call('Bearer x'), SECRET)]) {
      expect(refused?.headers.get('cache-control')).toBe('private, no-store');
    }
  });
});

describe('cronGate — the one caller it lets through', () => {
  it('returns null for exactly "Bearer <secret>", so the route proceeds', () => {
    expect(cronGate(call(`Bearer ${SECRET}`), SECRET)).toBeNull();
  });
});
