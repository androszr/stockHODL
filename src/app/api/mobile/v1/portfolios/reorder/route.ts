import { portfolioReorderSchema } from '@/lib/api/contracts';
import {
  jsonError,
  jsonOk,
  parseJsonBody,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { reorderPortfolios } from '@/lib/portfolios/mutations';

/**
 * Absolute reorder — its own route rather than a PATCH on the collection,
 * because it rewrites every row's `sortOrder` at once and is not a partial
 * update of anything.
 *
 * The list must be exactly the user's current set. A stale one (the phone
 * reordering a list a web tab has since changed) is refused with 409 and the
 * "reload and try again" message, never patched: holes and ties in
 * `sortOrder` are worse than an error the client can recover from.
 */
export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, portfolioReorderSchema);
  if (!body.ok) return body.response;

  const result = await reorderPortfolios(userId, body.data.ids);
  if (!result.ok) return jsonError(result.error, 409);

  return jsonOk({ ok: true });
}
