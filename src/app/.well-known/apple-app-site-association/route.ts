import { env } from '@/lib/env';

/**
 * Associated Domains file (docs/ios-native.md A.6.3).
 *
 * iOS fetches this over HTTPS from the apex of the rpID before it will let the
 * native client run a WebAuthn assertion against a passkey minted on the web.
 * Three constraints come from Apple, not from us, and each is load-bearing:
 *
 *   - It must be served at exactly `/.well-known/apple-app-site-association`,
 *     with NO redirect. Hence the exclusion in `src/proxy.ts` — the cookie gate
 *     would 307 Apple's unauthenticated fetcher to /login and the association
 *     would silently never form.
 *   - `Content-Type: application/json`, and no `.json` extension on the path.
 *   - It must be reachable on the PRODUCTION domain. A Vercel preview sits
 *     behind deployment protection, so this only ever verifies against
 *     the production host.
 *
 * Only `webcredentials` is published. `applinks` would additionally make the
 * app claim every https link to this domain — a dev build hijacking the URLs
 * of the web app it is supposed to complement. Out of scope, deliberately.
 *
 * Apple's CDN caches the response, so a Team ID arriving later can take hours
 * to be picked up; the app can be reinstalled to force a refetch during
 * development.
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  const appId = env().APPLE_APP_ID;

  if (!appId) {
    // No enrollment yet, so no app is associated with this domain. Saying so
    // plainly is more honest than publishing an empty `apps` list, which iOS
    // would cache as a valid "this domain associates with nothing".
    return Response.json({ error: 'Not configured.' }, { status: 404 });
  }

  return Response.json(
    { webcredentials: { apps: [appId] } },
    {
      headers: {
        'Content-Type': 'application/json',
        // Public and identical for everyone. An hour is short enough that a
        // corrected Team ID propagates the same day.
        'Cache-Control': 'public, max-age=3600',
      },
    },
  );
}
