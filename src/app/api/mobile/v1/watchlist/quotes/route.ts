import { jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { loadWatchlistInputs } from '@/lib/watchlist/live-view';
import { composeWatchlistPayload } from '@/lib/watchlist/watchlist-payload';

/**
 * The watchlist's live half, bearer-authenticated — the mobile twin of
 * `/api/quotes/watchlist`, composed from the identical server functions.
 *
 * The twin exists because `src/proxy.ts` is a COOKIE gate whose only
 * exclusion is `/api/mobile/`: the phone would be redirected to `/login` and
 * decode an HTML page as JSON. Same arrangement, same reasoning as the
 * holdings pair added in stage C2.
 *
 * Deliberately NO query parameters: the symbol set always comes from the
 * caller's own watchlist rows inside `loadWatchlistInputs`. A client-supplied
 * ticker list would be an open quote proxy for whoever holds a token.
 *
 * Path note: `quotes` is a STATIC segment and sits beside the dynamic
 * `[instrumentId]` DELETE route. Next resolves static first, which is what we
 * want — and an instrument id is a uuid, so nothing can ever legitimately be
 * named "quotes" here.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const { items, inputs, quotes } = await loadWatchlistInputs(userId);
  return jsonOk(composeWatchlistPayload(items, inputs, quotes));
}
