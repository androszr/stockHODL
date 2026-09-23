import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '@/lib/auth';
import { isNativeClient } from '@/lib/api/mobile/native-client';

/**
 * Wrapped rather than destructured at module scope. `const { GET, POST } =
 * toNextJsHandler(auth.handler)` would touch `auth` while Next is merely
 * collecting page data at build time, which defeats the lazy construction in
 * `@/lib/auth` and puts production secrets back on the build machine's
 * critical path.
 *
 * `auth` is memoized after the first call, so this costs one property lookup
 * per request.
 */

/**
 * The `bearer()` plugin's after-hook has matcher `() => true`: it appends
 * `set-auth-token` to EVERY Better Auth response that sets a session cookie —
 * web passkey sign-in and the daily `updateAge` refresh included, not just the
 * phone's. That would hand same-origin JS a signed 7-day credential that until
 * now existed only as an `httpOnly __Host-` cookie, i.e. it would quietly
 * revoke `httpOnly`'s entire guarantee for the app's only credential (found by
 * the S2 security review; the debt is written down in docs/ios-native.md
 * A.6.4).
 *
 * So the header leaves only when the caller declared itself native. A browser
 * never sends that declaration and cannot be made to send it cross-site, so a
 * leftover cookie session stays cookie-only — while the iOS client, which
 * sends it on every call including passkey assertion, password recovery
 * sign-in and enrollment, still receives the signed token it must store in
 * the Keychain.
 *
 * `Access-Control-Expose-Headers` goes with it: the plugin adds it solely to
 * make `set-auth-token` readable, so leaving it behind would only advertise a
 * header that is no longer there.
 */
function stripTokenHeader(request: Request, response: Response): Response {
  if (isNativeClient(request)) return response;

  const headers = new Headers(response.headers);
  if (!headers.has('set-auth-token')) return response;

  headers.delete('set-auth-token');
  headers.delete('access-control-expose-headers');

  // Body is a one-shot stream — pass the SAME one through rather than reading
  // it, so this stays free and never buffers a response.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function GET(request: Request) {
  return stripTokenHeader(request, await toNextJsHandler(auth.handler).GET(request));
}

export async function POST(request: Request) {
  return stripTokenHeader(request, await toNextJsHandler(auth.handler).POST(request));
}
