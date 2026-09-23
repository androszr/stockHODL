import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The one door check every `/api/cron/*` route runs first.
 *
 * Vercel Cron (and the price-alerts GitHub workflow) call these routes with
 * `Authorization: Bearer <CRON_SECRET>`. They are internet-reachable and the
 * proxy excludes them, so this check IS the boundary:
 *
 *   - no secret configured → 503 `Not configured.` — `CRON_SECRET` is optional
 *     in the env schema, and a job that cannot authenticate anyone must refuse
 *     to run rather than run open. This comes BEFORE the header check, so an
 *     unconfigured deploy never compares anything against an empty secret;
 *   - any header other than exactly `Bearer <secret>` → 401 `Unauthorized.`;
 *   - otherwise `null`, and the route proceeds.
 *
 * The comparison hashes both sides to SHA-256 before `timingSafeEqual`: the
 * primitive needs equal-length inputs, and comparing digests means there is no
 * early return on a length mismatch to leak the secret's length through.
 * Both refusals are deliberately vague and never cached.
 *
 * It reads nothing — the caller passes `env().CRON_SECRET` — so it needs no
 * `server-only` guard and is tested without an environment.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export function cronGate(request: Request, secret: string | undefined): Response | null {
  if (!secret) {
    return Response.json({ error: 'Not configured.' }, { status: 503, headers: NO_STORE });
  }

  const presented = createHash('sha256')
    .update(request.headers.get('authorization') ?? '')
    .digest();
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
  if (!timingSafeEqual(presented, expected)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: NO_STORE });
  }

  return null;
}
