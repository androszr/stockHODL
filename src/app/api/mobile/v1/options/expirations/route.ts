import { optionExpirationsQuerySchema } from '@/lib/api/contracts';
import { jsonOk, parseQuery, unauthorized } from '@/lib/api/mobile/respond';
import { toMobileExpiry } from '@/lib/api/mobile/option-chain-labels';
import { sessionUserId } from '@/lib/api/mobile/session';
import { listOptionExpirations } from '@/lib/market-data/massive';

/**
 * Expiry list for one underlying — the bearer twin of the
 * `getOptionExpirations` Server Action, over the same vendor call.
 *
 * Market data stays server-mediated (non-negotiable #4): the phone never
 * reaches Massive, it reaches this.
 *
 * A vendor failure answers `degraded`, NOT a 5xx. The web action does the
 * same, and the reason is the add flow: a hiccup mid-cascade must leave the
 * form usable and say so, never surface as a failed screen. The message and
 * status are logged; the key, the header and the URL never are.
 *
 * Path note: `expirations` is a STATIC segment beside the dynamic `[id]`
 * route. Next resolves static first, which is what we want — and a lot id is
 * a uuid, so nothing can legitimately be named "expirations" here.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const query = parseQuery(request, optionExpirationsQuerySchema);
  if (!query.ok) return query.response;

  try {
    const expirations = await listOptionExpirations(query.data.underlying);
    return jsonOk({ ok: true, expirations: expirations.map(toMobileExpiry) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'expirations lookup failed';
    console.error(`Mobile option expirations lookup failed: ${message}`);
    return jsonOk({ ok: false, degraded: true, reason: 'unavailable' });
  }
}
