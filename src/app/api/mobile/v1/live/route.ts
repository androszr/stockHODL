import { jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { getHoldingsView } from '@/lib/holdings/live-view';

/**
 * The polled half of the Holdings screen: just the `LivePayload`, refreshed on
 * the cadence `poll-policy.ts` allows.
 *
 * This is `/api/quotes` for a bearer client, and the duplication is not
 * accidental. `src/proxy.ts` is a COOKIE gate — it redirects anything without
 * a session cookie to `/login`, and the only prefix it excuses is
 * `/api/mobile/`. A phone sending nothing but `Authorization: Bearer` would
 * therefore get a 307 and an HTML login page where it expected JSON, which
 * decodes as a parse error and looks like a corrupt payload. Widening the
 * proxy's exclusion list instead would trade a documented deny-by-default
 * boundary for the sake of saving this file; a nine-line wrapper is cheaper
 * than a hole.
 *
 * `getHoldingsView` is the same composition `/api/quotes` calls, so the two
 * cannot drift: there is one live payload in this codebase, not a web one and
 * a mobile one.
 *
 * Deliberately NO query parameters, on the `/api/quotes` rule: the symbol set
 * comes from the caller's own rows. Every scope ships in the payload and the
 * client SELECTS one — it never asks for one.
 */

export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const { live } = await getHoldingsView(userId);
  return jsonOk(live);
}
