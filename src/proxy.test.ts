import { describe, expect, it } from 'vitest';

import { config } from './proxy';

/**
 * The matcher is the app's deny-by-default boundary, and every entry on its
 * exclusion list is a hole punched in that boundary for a caller that cannot
 * present a session cookie. Two of those holes arrived in stage S2 — the
 * mobile API and the Associated Domains file — and both are the kind of change
 * that is easy to get subtly wrong: a missing escape, or a prefix that matches
 * more than it was meant to.
 *
 * Next compiles this string with path-to-regexp; for a pattern that is a bare
 * negative lookahead like this one, anchoring it directly is faithful enough
 * to tell a matched path from an excluded one.
 */
const matcher = new RegExp(`^${config.matcher[0]}$`);

const gated = (path: string) => matcher.test(path);

describe('proxy matcher', () => {
  it('gates HTML, including the deleted pre-auth surfaces', () => {
    for (const path of ['/', '/login', '/offline', '/portfolios', '/holdings/AAPL']) {
      expect(gated(path), path).toBe(true);
    }
  });

  it('lets the remaining JSON doors through', () => {
    for (const path of [
      '/api/auth/passkey/generate-authenticate-options',
      '/api/cron/backfill',
    ]) {
      expect(gated(path), path).toBe(false);
    }
  });

  it('lets the native client reach the mobile API without a cookie', () => {
    // The gate would have turned every Bearer call into a 404.
    // Each handler under this prefix guards itself with `sessionUserId`.
    for (const path of [
      '/api/mobile/v1/bootstrap',
      '/api/mobile/v1/transactions',
      '/api/mobile/v1/series/price/AAPL',
    ]) {
      expect(gated(path), path).toBe(false);
    }
  });

  it('lets Apple fetch the Associated Domains file, at its exact path only', () => {
    expect(gated('/.well-known/apple-app-site-association')).toBe(false);
    // The rest of /.well-known is not a public directory by accident.
    expect(gated('/.well-known/anything-else')).toBe(true);
  });

  it('excludes on a path boundary, not a bare prefix', () => {
    // Every entry in the list is a prefix match. Without the trailing slash
    // and the anchor, each of these would inherit the exclusion of the route
    // whose name it merely starts with — a route added years from now, by
    // someone who never read this file, shipping outside deny-by-default.
    for (const path of [
      '/api/mobilefoo',
      '/api/mobile-admin',
      '/.well-known/apple-app-site-associationX',
    ]) {
      expect(gated(path), path).toBe(true);
    }
  });
});
