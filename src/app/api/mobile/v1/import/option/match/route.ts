import { optionMatchRequestSchema } from '@/lib/api/contracts';
import { toMobileContractRef } from '@/lib/api/mobile/option-chain-labels';
import { jsonOk, parseJsonBody, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import {
  listNearbyOptionContracts,
  listOptionStrikes,
  massiveProvider,
} from '@/lib/market-data/massive';
import { matchExact, rankAlternatives } from '@/lib/options/contract-match';

/**
 * THE VERIFICATION GATE — the bearer twin of `matchOptionContract` in
 * `(app)/options/actions.ts`. Same reasoning: a screenshot NAMES a contract
 * but does not RESOLVE one, and nothing parsed from an image reaches
 * `option_positions` unless this endpoint found it on the vendor's own
 * contracts reference. Deliberately a second call from
 * `POST /api/mobile/v1/import/option` (the vision read costs money, this
 * does not — a corrected strike re-runs only the free half).
 *
 * Before this route existed, the phone's add-cascade did its own exact
 * STRING match against the `expirations`/`strikes` lists it had already
 * fetched, with no near-miss fallback: a screenshot read one day off (or a
 * strike not exactly listed) landed on a bare "not found" instead of the
 * web's ranked list of the closest real contracts. That gap is exactly what
 * `nearby`/`rankAlternatives` below closes.
 */
export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, optionMatchRequestSchema);
  if (!body.ok) return body.response;

  const { underlying, companyName, contractType, strikePrice, expirationDate } = body.data;

  try {
    // (a) Candidate underlyings: the validated ticker candidate wins; else
    // the top company-name search hits (server-side, session-guarded here).
    let candidates: string[];
    if (underlying !== undefined) {
      candidates = [underlying];
    } else if (companyName !== undefined) {
      const search = await massiveProvider.searchSymbols(companyName);
      candidates = [...new Set(search.results.map((m) => m.symbol.toUpperCase()))].slice(0, 3);
    } else {
      candidates = [];
    }
    if (candidates.length === 0) return jsonOk({ status: 'unresolved' });

    for (const candidate of candidates) {
      // (b) One call confirms underlying + expiry + type together.
      const contracts = await listOptionStrikes(candidate, expirationDate, contractType);
      if (contracts.length > 0) {
        const exact = matchExact(contracts, strikePrice);
        if (exact !== null) {
          return jsonOk({ status: 'matched', contract: toMobileContractRef(exact) });
        }
        // (c) Strike near miss — the same list IS the alternatives set.
        return jsonOk({
          status: 'nearby',
          alternatives: rankAlternatives(contracts, strikePrice, expirationDate).map(
            toMobileContractRef,
          ),
        });
      }

      // (d) Empty cell — expiry near miss: one direct filtered window query.
      const nearby = await listNearbyOptionContracts(
        candidate,
        contractType,
        expirationDate,
        strikePrice,
      );
      if (nearby.length > 0) {
        return jsonOk({
          status: 'nearby',
          alternatives: rankAlternatives(nearby, strikePrice, expirationDate).map(
            toMobileContractRef,
          ),
        });
      }
    }

    // (e) No candidate resolved to anything listed.
    return jsonOk({ status: 'unresolved' });
  } catch (error) {
    // Never the key, the header, or a URL — message/status only.
    const message = error instanceof Error ? error.message : 'contract match failed';
    console.error(`Mobile option contract match failed: ${message}`);
    return jsonOk({ status: 'degraded', reason: 'unavailable' });
  }
}
