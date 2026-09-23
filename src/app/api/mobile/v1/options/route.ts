import { optionPositionAddRequestSchema } from '@/lib/api/contracts';
import {
  jsonOk,
  parseJsonBody,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { loadOptionsInputs } from '@/lib/options/live-view';
import { insertOptionPosition } from '@/lib/options/mutations';
import { composeLiveOptionsPayload } from '@/lib/options/options-payload';

/**
 * The Options tab's live payload, and the door to add a lot — the bearer twin
 * of `/api/quotes/options` plus `addOptionPosition`, composed from the
 * identical server functions.
 *
 * The twin exists because `src/proxy.ts` is a COOKIE gate whose only
 * exclusion is `/api/mobile/`: the phone would be redirected to `/login` and
 * decode an HTML page as JSON. Same arrangement, same reasoning as the
 * holdings and watchlist pairs.
 *
 * Deliberately NO query parameters on the GET: the ticker set always comes
 * from the caller's own `option_positions` rows inside `loadOptionsInputs`. A
 * client-supplied ticker list would be an open options-quote proxy for
 * whoever holds a token — the same refusal the web route documents.
 *
 * Poll-only, no SSE twin: the options socket entitlement is unverified, and
 * 60 s is honest for 15-minute-delayed greeks. The loader's bar sync is
 * TTL-cached per ticker, so a poll never fans out aggregates requests.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const loaded = await loadOptionsInputs(userId);
  return jsonOk(composeLiveOptionsPayload(loaded));
}

export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  // `optionPositionAddSchema` verbatim — the same bounds, trims and pl-PL
  // comma normalisation the web add-flow submits through. The phone cannot
  // get a laxer door into `option_positions` than the form has.
  const body = await parseJsonBody(request, optionPositionAddRequestSchema);
  if (!body.ok) return body.response;

  await insertOptionPosition(userId, body.data);
  return jsonOk({ ok: true }, 201);
}
