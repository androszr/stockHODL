import type { NextConfig } from 'next';

import { resolveBuildId } from './scripts/build-id.mjs';

const isProd = process.env.NODE_ENV === 'production';

/**
 * One opaque id per deploy — see scripts/build-id.mjs for the derivation and
 * why it must stay deterministic. Published on the X-Build-Id header so every
 * artifact of one deploy agrees on its identity.
 */
const buildId = resolveBuildId();

/**
 * docs/context.md § Auth (hardening decisions). The CSP is unusually tight because ALL market data is
 * server-mediated — the phone never talks to Massive or NBP, so no
 * third-party origin needs to appear here. If a future change needs one, that
 * is a signal the fetch belongs on the server instead.
 *
 * 'unsafe-inline' on style-src is required by Next's inlined critical CSS; it
 * is low-risk relative to script-src. Dev additionally needs 'unsafe-eval' for
 * React Refresh — production does not get it.
 *
 * worker-src is stated EXPLICITLY rather than left to inherit. Per CSP Level 3
 * the fallback chain is worker-src → child-src → SCRIPT-SRC → default-src: it
 * does pass through script-src, so a future edit that loosens script-src (a CDN
 * origin, a wildcard) would have widened where workers may be loaded from as a
 * side effect. Naming worker-src 'self' pins workers to same-origin regardless
 * of what script-src later grows.
 *
 * connect-src stays 'self': market data stays server-mediated.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isProd ? ['upgrade-insecure-requests'] : []),
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    // publickey-credentials-get is required for passkeys; everything else off.
    value:
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), publickey-credentials-get=(self)',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  {
    key: 'X-Build-Id',
    value: buildId,
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // A type error must fail the build, not get waved through.
  // (Next 16 no longer runs ESLint during `next build`; CI runs `pnpm lint`
  // as its own job instead — see .github/workflows/ci.yml.)
  typescript: { ignoreBuildErrors: false },

  // Don't advertise the framework version to scanners.
  poweredByHeader: false,

  // Pin Next's own build id to ours so every artifact of one deploy agrees on
  // its identity.
  generateBuildId: () => buildId,

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
