import { symbolSearchQuerySchema } from '@/lib/api/contracts';
import { jsonOk, parseQuery, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { searchSymbols } from '@/lib/market-data/search';

/**
 * The transaction form's combobox, bearer-authenticated.
 *
 * A twin of `/api/symbols/search` rather than a call into it: `src/proxy.ts`
 * is a cookie gate whose only exclusion is `/api/mobile/`, so the phone would
 * be redirected to `/login` and decode an HTML page as JSON. Both handlers
 * answer from `searchSymbols` in `src/lib/market-data/search.ts`, so there is
 * one search and no way for the two clients to see different results.
 *
 * Session-guarded even though a ticker list is not secret: this route spends
 * the paid provider's quota, and an unauthenticated proxy to a vendor is worth
 * refusing whatever the payload is. Non-negotiable #4 holds either way — the
 * phone never learns the vendor exists.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const query = parseQuery(request, symbolSearchQuerySchema);
  if (!query.ok) return query.response;

  return jsonOk(await searchSymbols(query.data.q));
}
