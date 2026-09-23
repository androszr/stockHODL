import 'server-only';

import { eq } from 'drizzle-orm';

import { db, newsArticles } from '@/lib/db';
import { getPublisherLogoAsset } from '@/lib/market-data/massive';

/**
 * The two news asset proxies — hero image and publisher logo — as functions
 * rather than route bodies, on the `src/lib/market-data/logo.ts` model.
 *
 * They moved here when the phone got a news screen (2026-08-18): `proxy.ts`
 * is a COOKIE gate excluding only `/api/mobile/`, so a bearer client asking
 * the browser routes would be redirected to `/login` and decode an HTML page
 * as image bytes. Each proxy therefore needs a mobile twin, and this is the
 * body both halves call. Only the AUTH differs between them.
 *
 * Every security decision below is load-bearing and none of it is per-route:
 *
 *  - NOT an open proxy. The caller supplies only an article id; the URL
 *    fetched is the one the app itself stored at fetch time. The vendor is
 *    never re-asked by id and a client-supplied URL is never fetched.
 *  - NO credential rides toward a publisher origin. News images live on
 *    public publisher/CDN hosts; the vendor key must never travel to a third
 *    party. That absence is also what makes `redirect: 'follow'` acceptable
 *    for the hero image where the logo route forbids it — a redirect chain
 *    can leak nothing it never carried. Never copy the logo route's
 *    authenticated-fetch shape into the image path.
 *  - https on the WAY OUT and on the way BACK. The starting URL is gated, and
 *    `response.url` is re-checked because `follow` can land on http:// down a
 *    publisher's chain; plaintext-fetched bytes must not be re-served from
 *    our https origin as if they were trustworthy.
 *  - Content-Type ALLOWLIST, never pass-through. These bytes are re-served
 *    from our own origin, and `image/svg+xml` is excluded everywhere: an SVG
 *    served same-origin is a script-carrying document.
 *  - Every failure — missing row, bad URL, timeout, oversize, wrong type — is
 *    the SAME negative-cached 404, so a broken image cannot be used to probe
 *    which articles exist beyond what the session already shows.
 */

/** Every failure shape is one cacheable 404 — see the note above. */
const IMAGE_NOT_FOUND_HEADERS = { 'Cache-Control': 'private, max-age=3600' };
const LOGO_NOT_FOUND_HEADERS = { 'Cache-Control': 'private, max-age=86400' };

const FETCH_TIMEOUT_MS = 5000;

/** 3 MB — hero images observed are a few hundred KB; anything bigger is off. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** Raster only — `image/svg+xml` deliberately excluded (see header comment). */
const IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function imageNotFound(): Response {
  return new Response(null, { status: 404, headers: IMAGE_NOT_FOUND_HEADERS });
}

/** The hero image for one article, proxied. */
export async function newsImageResponse(id: string): Promise<Response> {
  // The stored URL, database only — the vendor cannot be re-asked by id.
  let imageUrl: string | null;
  try {
    const [row] = await db
      .select({ imageUrl: newsArticles.imageUrl })
      .from(newsArticles)
      .where(eq(newsArticles.id, id))
      .limit(1);
    imageUrl = row?.imageUrl ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'image lookup failed';
    console.error(`News image lookup failed: ${message}`);
    return imageNotFound();
  }

  if (imageUrl === null || !imageUrl.startsWith('https://')) return imageNotFound();

  try {
    const response = await fetch(imageUrl, {
      // No headers at all — see the header comment: nothing secret may ride
      // to a publisher origin, which is also what makes `follow` safe.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
      redirect: 'follow',
    });
    if (!response.ok) return imageNotFound();
    if (!response.url.startsWith('https://')) return imageNotFound();

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      console.error(`News image failed: body too large (${bytes.byteLength} bytes)`);
      return imageNotFound();
    }

    const vendorType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!IMAGE_CONTENT_TYPES.has(vendorType)) return imageNotFound();

    return new Response(bytes, {
      headers: {
        'Content-Type': vendorType,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'image fetch failed';
    console.error(`News image failed: ${message}`);
    return imageNotFound();
  }
}

/**
 * The publisher's mark for one article, proxied. All fetch policy lives in
 * `getPublisherLogoAsset` (massive.ts, the only module that knows a vendor
 * origin or the key); this supplies the DB-stored URLs and the headers.
 */
export async function publisherLogoResponse(id: string): Promise<Response> {
  const notFound = () =>
    new Response(null, { status: 404, headers: LOGO_NOT_FOUND_HEADERS });

  let logoUrl: string | null = null;
  let faviconUrl: string | null = null;
  try {
    const [row] = await db
      .select({
        logoUrl: newsArticles.publisherLogoUrl,
        faviconUrl: newsArticles.publisherFaviconUrl,
      })
      .from(newsArticles)
      .where(eq(newsArticles.id, id))
      .limit(1);
    logoUrl = row?.logoUrl ?? null;
    faviconUrl = row?.faviconUrl ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'publisher logo lookup failed';
    console.error(`Publisher logo lookup failed: ${message}`);
    return notFound();
  }

  // logo_url first; the favicon steps in when the logo is absent,
  // off-vendor-origin, or not an allowlisted raster type (all `not_found`
  // inside the helper — an svg logo typically rasterizes through its ICO
  // favicon this way). A transient error is NOT papered over with the
  // favicon: the next request retries the better asset.
  for (const url of [logoUrl, faviconUrl]) {
    if (url === null) continue;
    const outcome = await getPublisherLogoAsset(url);
    if (outcome.ok) {
      return new Response(outcome.bytes, {
        headers: {
          'Content-Type': outcome.contentType,
          // Immutable: publisher marks change ~never, and at one user the
          // client is the only cache.
          'Cache-Control': 'private, max-age=2592000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (outcome.reason === 'error') return notFound();
  }

  return notFound();
}
