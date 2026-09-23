import type { z } from 'zod';

/**
 * The response shapes and request parsing every `/api/mobile/v1/*` handler
 * uses, so a handler is only ever its own three lines — guard, parse, call
 * the same `src/lib/**` function the Server Action calls.
 *
 * Deliberately free of any `auth` or database import: this module is pure
 * request/response plumbing and is unit-tested as such. The session guard
 * lives next door in `session.ts`, which does import `auth` and therefore
 * cannot be imported from a plain test.
 *
 * `private, no-store` on EVERY answer, including errors: no cache between the
 * phone and this handler should ever hold a payload.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export function jsonOk(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

export const unauthorized = () => jsonError('Not signed in.', 401);
export const notFound = (what = 'Not found.') => jsonError(what, 404);
export const badRequest = (why: string) => jsonError(why, 400);

/** Methods that change state, and therefore need a forgery check. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cross-site write detection for `/api/mobile/v1/*`.
 *
 * Stage S2 excluded these routes from the `src/proxy.ts` cookie gate so the
 * phone's `Authorization: Bearer …` calls stop being redirected to /login.
 * That exclusion means a mutating route is now reachable by a cross-site form
 * post that rides the browser's cookie. `sameSite: 'lax'` on the session
 * cookie already stops that, but a single cookie attribute is thin cover for
 * every write path in the app, and the check that thickens it is four lines:
 *
 *   - a request that carries a bearer token AND NO COOKIE is the native
 *     client: a browser never attaches `Authorization` by itself, and the
 *     absent cookie is what makes that conclusive. Exempting anything merely
 *     carrying the header would have turned `Authorization: Bearer x` into a
 *     free pass back onto the cookie session behind it;
 *   - otherwise the request is cookie-authenticated and must name this exact
 *     origin. Browsers send `Origin` on every unsafe method, so a MISSING one
 *     is refused rather than trusted.
 *
 * Reads are exempt: they mutate nothing, and the same-origin policy keeps a
 * cross-site reader from seeing the response body anyway.
 *
 * Pure by design — the expected origin is passed in, so this stays testable
 * without the env module. `session.ts` supplies `BETTER_AUTH_URL`.
 */
export function isCrossSiteWrite(request: Request, appOrigin: string): boolean {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (request.headers.get('authorization') && !request.headers.get('cookie')) return false;
  return request.headers.get('origin') !== appOrigin;
}

/**
 * Zod issue → the same one-line `field: message` string the Server Actions
 * put in `ActionState.error`, so a validation refusal reads identically
 * whether it reached the user through a form or through the phone.
 */
export function firstIssueMessage(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid input.';
  const field = first.path.join('.');
  return field ? `${field}: ${first.message}` : first.message;
}

/**
 * Parse a JSON request body against a schema. A malformed body and a body
 * that fails the schema both come back as the same 400 — there is nothing
 * for the client to learn from the difference.
 */
export async function parseJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<{ ok: true; data: z.output<T> } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: badRequest('Expected a JSON body.') };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: badRequest(firstIssueMessage(parsed.error)) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Parse a URL's search params against a schema. Absent params are dropped
 * rather than passed as `null`, so `.optional()` in a query schema means what
 * it looks like it means.
 */
export function parseQuery<T extends z.ZodType>(
  request: Request,
  schema: T,
): { ok: true; data: z.output<T> } | { ok: false; response: Response } {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string> = {};
  for (const [key, value] of params) raw[key] = value;

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: badRequest(firstIssueMessage(parsed.error)) };
  }
  return { ok: true, data: parsed.data };
}
