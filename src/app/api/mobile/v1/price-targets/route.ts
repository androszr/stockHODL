import {
  createTarget,
  type CreateTargetRefusal,
} from '@/lib/alerts/target-store';
import { priceTargetCreateRequestSchema } from '@/lib/api/contracts';
import { jsonError, jsonOk, parseJsonBody, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';

/**
 * Set a price target (plans/2026-09-05-price-target-alerts.md). Three lines
 * over `target-store.ts`, the watchlist-route pattern: guard, parse, one
 * store call. Answers the instrument's fresh target list so the screen
 * updates without refetching the whole detail payload. There is no GET here
 * — the list rides in `/api/mobile/v1/instrument/[symbol]`.
 */

/** Refusal → status. 409 for scope (held-or-watched, USD-only), 400 for a
 *  directionless price, 503 when no price exists to derive a direction from. */
const REFUSAL_STATUS: Record<CreateTargetRefusal, number> = {
  not_followed: 409,
  unsupported_currency: 409,
  equal_price: 400,
  no_price: 503,
};

export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, priceTargetCreateRequestSchema);
  if (!body.ok) return body.response;

  const result = await createTarget(userId, body.data.instrumentId, body.data.targetPrice);
  if (!result.ok) return jsonError(result.error, REFUSAL_STATUS[result.reason]);

  // The fresh list AND the recomputed proximity status — the screen's
  // sentence updates without refetching the whole detail payload.
  return jsonOk({ targets: result.targets, status: result.status });
}
