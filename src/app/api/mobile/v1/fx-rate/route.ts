import { fxRateQuerySchema } from '@/lib/api/contracts';
import {
  jsonOk,
  parseQuery,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { getFxRateToPln } from '@/lib/fx/nbp';

/**
 * D-1 NBP rate lookup (art. 11a PIT/CIT) for the native transaction form —
 * the endpoint twin of the `getFxRate` Server Action.
 *
 * "Market data is server-mediated" covers NBP exactly as it covers the quote
 * vendor: `src/lib/fx/nbp.ts` keeps sole ownership of the vendor URL and the
 * `fx_rates` read-through cache, and the phone never learns that
 * `api.nbp.pl` exists.
 *
 * Session-guarded even though the rate is public: an unauthenticated proxy to
 * a third party is worth having whatever the payload is, and the cache it
 * warms is ours to pay for.
 *
 * PLN is rejected by the schema, mirroring the action: the client
 * short-circuits to '1', and asking NBP for a PLN/PLN rate is a bug.
 * A refusal is answered 200 with `ok: false` rather than a status code — the
 * distinction between "not published yet" and "vendor down" is data the
 * client acts on, not a transport error.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const query = parseQuery(request, fxRateQuerySchema);
  if (!query.ok) return jsonOk({ ok: false, reason: 'invalid' });

  return jsonOk(await getFxRateToPln(query.data));
}
