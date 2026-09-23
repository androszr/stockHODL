import 'server-only';

import { massiveProvider } from '@/lib/market-data/massive';

/**
 * The brand-icon proxy's body, shared by the cookie-guarded browser route
 * (`/api/logo/[symbol]`) and its bearer-guarded mobile twin
 * (`/api/mobile/v1/logo/[symbol]`).
 *
 * Extracted when the native client grew logo tiles: the two routes differ
 * ONLY in how they establish who is calling. The part that matters — the
 * injection gate, the negative cache, the fact that the vendor URL is never
 * surfaced because surfacing it would surface the API key — has exactly one
 * implementation, so a fix to it cannot land on one surface and miss the
 * other.
 */

/**
 * The injection gate: the param lands inside a vendor URL path. Uppercase
 * ticker alphabet only — and although `.` is legitimate (BRK.A), a `..`
 * sequence never is, so path traversal toward the vendor API is rejected
 * outright rather than encoded and hoped about.
 */
const SYMBOL_RE = /^[A-Z0-9.\-]{1,12}$/;

export function isLogoSymbol(symbol: string): boolean {
  return SYMBOL_RE.test(symbol) && !symbol.includes('..');
}

/** Bytes, or the 404 that renders as a monogram. Callers authenticate first. */
export async function logoResponse(symbol: string): Promise<Response> {
  const outcome = await massiveProvider.getBrandingIcon(symbol);
  if (!outcome.ok) {
    // Both "no logo exists" and a transient vendor failure render the same
    // monogram; a day of negative cache keeps `.WA`-style symbols quiet
    // without freezing a future rebrand out for a month.
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': 'private, max-age=86400' },
    });
  }

  return new Response(outcome.bytes, {
    headers: {
      'Content-Type': outcome.contentType,
      // Immutable for the browser: brand tiles change ~never, and at one
      // user the browser cache is the only cache in play.
      'Cache-Control': 'private, max-age=2592000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
