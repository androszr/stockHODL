import 'server-only';

import { isCrossSiteWrite } from '@/lib/api/mobile/respond';
import { auth } from '@/lib/auth';
import { env } from '@/lib/env';

/**
 * The session guard for `/api/mobile/v1/*`, on its own so the response
 * plumbing in `respond.ts` stays importable from a unit test.
 *
 * Discipline is the `/api/quotes` pattern verbatim: `getSession` first, 401
 * without one. The two allowlist gates in `src/lib/auth.ts` sit upstream of
 * session creation and are untouched by this layer — the native client is a
 * new consumer of the same single sign-in method, never a second one.
 *
 * Every handler calls this itself: the `(app)` layout gate protects pages,
 * not routes, and a route invoked directly over HTTP has no layout above it.
 * Since stage S2 these routes are also excluded from the `src/proxy.ts` cookie
 * redirect, so this call is the ONLY thing standing in front of them.
 *
 * Two ways in, one answer. A browser session arrives as a cookie; the phone
 * sends `Authorization: Bearer <signed session token>` and the `bearer()`
 * plugin resolves it inside this same `getSession` call — nothing here has to
 * know which one it got. A cross-site write is refused before the session is
 * even looked up, and refused as "not signed in": there is nothing for a
 * hostile page to learn from a more precise answer.
 */
export async function sessionUserId(request: Request): Promise<string | null> {
  if (isCrossSiteWrite(request, new URL(env().BETTER_AUTH_URL).origin)) return null;

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user.id ?? null;
  } catch (error) {
    // Rethrown as-is (a genuine DB outage must still surface as a 5xx, not a
    // false 401 — a 401 tells the iOS widget the session is gone and it
    // should stop trusting its cache, which is the wrong answer for a
    // transient Neon compute-wake hiccup). Logged here only because this is
    // the single choke point every mobile route calls through, and an
    // unlogged throw here was previously indistinguishable from a genuine
    // vendor outage in the iOS options cascade's generic "unavailable"
    // message. Message only — never the headers or the URL.
    const message = error instanceof Error ? error.message : 'session lookup failed';
    console.error(`Mobile session lookup failed: ${message}`);
    throw error;
  }
}
