import { describe, expect, it } from 'vitest';

import {
  isNativeClient,
  NATIVE_CLIENT_HEADER,
  NATIVE_CLIENT_VALUE,
} from './native-client';

const req = (headers: Record<string, string> = {}) =>
  new Request('https://sawa-finance.vercel.app/api/auth/sign-in/passkey', { headers });

describe('isNativeClient', () => {
  it('accepts the exact declaration the iOS client sends', () => {
    expect(isNativeClient(req({ [NATIVE_CLIENT_HEADER]: NATIVE_CLIENT_VALUE }))).toBe(true);
  });

  it('is false for a browser, which never sends the header', () => {
    expect(isNativeClient(req())).toBe(false);
  });

  it('is false for a near-miss value — no prefix or substring matching', () => {
    expect(isNativeClient(req({ [NATIVE_CLIENT_HEADER]: 'ios-web' }))).toBe(false);
    expect(isNativeClient(req({ [NATIVE_CLIENT_HEADER]: 'android' }))).toBe(false);
    expect(isNativeClient(req({ [NATIVE_CLIENT_HEADER]: '' }))).toBe(false);
  });

  it('refuses a browser that sets the header on its own fetch', () => {
    // The XSS shape: same-origin script adds the declaration itself. A browser
    // cannot suppress `Sec-Fetch-Site`, so the request is still recognisably
    // a browser's.
    expect(
      isNativeClient(
        req({ [NATIVE_CLIENT_HEADER]: NATIVE_CLIENT_VALUE, 'sec-fetch-site': 'same-origin' }),
      ),
    ).toBe(false);
    // Cross-site and none-navigation forms are equally disqualifying — the
    // check is presence, never the value.
    expect(
      isNativeClient(
        req({ [NATIVE_CLIENT_HEADER]: NATIVE_CLIENT_VALUE, 'sec-fetch-site': 'cross-site' }),
      ),
    ).toBe(false);
  });

  it('matches the header name case-insensitively, as HTTP requires', () => {
    // Header names are case-insensitive per spec; the VALUE is not, and the
    // check must not quietly become a lowercase comparison of both.
    expect(isNativeClient(req({ 'X-StockHODL-Client': 'ios' }))).toBe(true);
    expect(isNativeClient(req({ [NATIVE_CLIENT_HEADER]: 'IOS' }))).toBe(false);
  });
});
