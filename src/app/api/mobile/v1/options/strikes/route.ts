import { optionStrikesQuerySchema } from '@/lib/api/contracts';
import { jsonOk, parseQuery, unauthorized } from '@/lib/api/mobile/respond';
import { toMobileContractRef } from '@/lib/api/mobile/option-chain-labels';
import { sessionUserId } from '@/lib/api/mobile/session';
import { listOptionStrikes } from '@/lib/market-data/massive';

/**
 * Strike list for one (underlying, expiry, call/put) cell — the bearer twin
 * of the `getOptionStrikes` Server Action, over the same vendor call.
 *
 * Same two rules as the expirations route: market data stays server-mediated,
 * and a vendor failure degrades rather than 5xx-ing so the add cascade stays
 * usable and honest about what it could not fetch.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const query = parseQuery(request, optionStrikesQuerySchema);
  if (!query.ok) return query.response;

  try {
    const contracts = await listOptionStrikes(
      query.data.underlying,
      query.data.expirationDate,
      query.data.contractType,
    );
    return jsonOk({ ok: true, contracts: contracts.map(toMobileContractRef) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'strikes lookup failed';
    console.error(`Mobile option strikes lookup failed: ${message}`);
    return jsonOk({ ok: false, degraded: true, reason: 'unavailable' });
  }
}
