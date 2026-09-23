import { describe, expect, it } from 'vitest';

import { pushTokenRequestSchema } from './push';

/** A realistic APNs device token: 64 hex characters, as the device emits. */
const TOKEN = 'a'.repeat(32) + 'B'.repeat(32);

describe('pushTokenRequestSchema', () => {
  it('accepts a hex device token with its environment', () => {
    const parsed = pushTokenRequestSchema.parse({
      token: TOKEN,
      environment: 'production',
    });
    expect(parsed).toEqual({ token: TOKEN, environment: 'production' });
  });

  it('rejects an empty token', () => {
    expect(() => pushTokenRequestSchema.parse({ token: '', environment: 'sandbox' })).toThrow();
  });

  it('rejects an environment outside the closed pair', () => {
    expect(() => pushTokenRequestSchema.parse({ token: TOKEN, environment: 'dev' })).toThrow();
  });

  /**
   * The token reaches an HTTP/2 `:path` in `src/lib/push/apns.ts`, signed with
   * our provider JWT — so a non-hex token must be refused at the boundary
   * rather than shaping a request to Apple.
   */
  it('rejects a token carrying path characters', () => {
    expect(() =>
      pushTokenRequestSchema.parse({ token: `../${TOKEN}`, environment: 'sandbox' }),
    ).toThrow();
  });

  it('rejects a token too short to be a real APNs token', () => {
    expect(() => pushTokenRequestSchema.parse({ token: 'a1b2c3d4', environment: 'sandbox' })).toThrow();
  });
});
