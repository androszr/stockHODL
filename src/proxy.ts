import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Deny by default (docs/context.md § Auth). Everything outside the matcher's exclusion list
 * requires a session.
 *
 * (Next 16 renamed the `middleware` convention to `proxy`; same semantics.)
 *
 * This is an OPTIMISTIC check — it only proves a session cookie is present and
 * correctly signed-looking, not that the session is live in the database. That
 * is deliberate: the proxy runs on every request and a DB round-trip here would
 * tax every navigation. There is no product HTML left to authoritatively
 * validate: unauthenticated documents 404, and every remaining JSON door
 * (`/api/auth/*`, `/api/mobile/v1/*`, `/api/cron/*`) guards itself.
 */
export function proxy(request: NextRequest) {
  const isProd = request.nextUrl.protocol === 'https:';

  const sessionCookie = getSessionCookie(request, {
    cookiePrefix: isProd ? '__Host-' : 'stock-follow',
  });

  if (!sessionCookie) {
    return new NextResponse(null, { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   /api/auth/*       — the auth handler itself
     *   /api/mobile/*     — the native iOS client authenticates with
     *                       `Authorization: Bearer <session token>`, never a
     *                       cookie (docs/ios-native.md A.6.4), so a cookie
     *                       gate here would 404 every call. This exclusion
     *                       does NOT open the routes: every handler under it
     *                       calls `sessionUserId` first and answers 401
     *                       without a session, which is what makes that
     *                       branch reachable at all. Cross-site forgery is
     *                       covered separately — see `isCrossSiteWrite` in
     *                       src/lib/api/mobile/respond.ts.
     *   /api/cron/*       — Vercel Cron sends `Authorization: Bearer CRON_SECRET`
     *                       with no session cookie; a cookie gate here would 404
     *                       every scheduled run. The route guards itself:
     *                       timing-safe bearer check, 503 when CRON_SECRET is
     *                       unset, 401 on mismatch — nothing runs
     *                       unauthenticated.
     *   /.well-known/apple-app-site-association
     *                     — Apple's unauthenticated fetcher validates the
     *                       Associated Domains file before iOS will allow a
     *                       native passkey assertion, and it follows NO
     *                       redirect. A 404 here does not fail loudly; it
     *                       just means the association never forms. The file
     *                       publishes one public app identifier.
     *   Next internals and static files
     */
    /*
     * Note the trailing `/` on the two prefixes and the `$` on the AASA path:
     * every entry here is a PREFIX match, so `api/mobile`
     * without the slash would also excuse a future `/api/mobilefoo` from the
     * gate, and the Associated Domains path without the anchor would excuse
     * `…-associationX`. Deny-by-default is only as good as its holes are
     * narrow. src/proxy.test.ts pins both.
     */
    '/((?!api/auth|api/cron|api/mobile/|\\.well-known/apple-app-site-association$|_next/static|_next/image).*)',
  ],
};
