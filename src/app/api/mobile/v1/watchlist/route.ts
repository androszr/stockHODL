import { watchlistAddRequestSchema } from '@/lib/api/contracts';
import {
  jsonError,
  jsonOk,
  parseJsonBody,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { addToWatchlist, listWatchlist } from '@/lib/watchlist/mutations';

/**
 * Watchlist membership. Quotes for these rows do NOT come from here — this
 * route is pure membership, which is what a watch is.
 *
 * Where those quotes WILL come from is a mobile-namespaced twin of
 * `/api/quotes/watchlist`, not that route itself: `src/proxy.ts` is a cookie
 * gate whose only exclusion is `/api/mobile/`, so a bearer client is redirected
 * to `/login` everywhere else. Stage C2 hit exactly this and added
 * `/api/mobile/v1/live` (+ `/stream`); the watchlist screen needs the same
 * treatment when it lands.
 */

export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  return jsonOk({ items: await listWatchlist(userId) });
}

export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, watchlistAddRequestSchema);
  if (!body.ok) return body.response;

  const result = await addToWatchlist(userId, body.data);
  // The only failure is `resolveOrCreateInstrument`'s currency-mismatch
  // refusal ("already exists as …") — a conflict with a globally-bound
  // symbol, not a malformed request.
  if (!result.ok) return jsonError(result.error, 409);

  // Idempotent on the composite PK: re-adding an already-watched stock is a
  // no-op answered 200, never an error — the tile is simply already there.
  return jsonOk({ ok: true });
}
