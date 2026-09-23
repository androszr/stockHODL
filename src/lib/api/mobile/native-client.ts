/**
 * How a request says "I am the native client, not a browser".
 *
 * A browser cannot be made to send this header cross-site without a preflight
 * the app never answers, and the web app itself never sends it — so its
 * presence is a statement only our own iOS build can make. It is NOT a
 * credential and grants nothing on its own: everything it gates is either
 * already authenticated or, as with `set-auth-token`, a value the caller had
 * to sign in to receive in the first place.
 *
 * It must be sent on EVERY call including sign-in. Gating on `Authorization`
 * instead would be circular — at enrollment the phone has no token yet, which
 * is precisely the response it needs the token from.
 */
export const NATIVE_CLIENT_HEADER = 'x-stockhodl-client';

/** The one accepted value — a version-free name, so a rebuild never breaks. */
export const NATIVE_CLIENT_VALUE = 'ios';

export function isNativeClient(request: Request): boolean {
  if (request.headers.get(NATIVE_CLIENT_HEADER) !== NATIVE_CLIENT_VALUE) return false;

  /**
   * The header alone is something a same-origin script could set on its own
   * `fetch`, which would let an injected script ask for the very token the
   * strip exists to withhold. `Sec-Fetch-Site` closes that: it is a FORBIDDEN
   * header name, so a browser always attaches it to fetch/XHR and no script
   * can suppress or forge its absence — while iOS `URLSession`, which is not
   * a browser, never sends it at all.
   *
   * Absence is therefore the honest signal, and reading it costs the phone
   * nothing. A browser too old to send it (pre-16.4 Safari) is unaffected in
   * every way that matters: the web never wants this token anyway.
   */
  return !request.headers.has('sec-fetch-site');
}
