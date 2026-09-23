import { analyticsResponseSchema } from '@/lib/api/contracts';
import { jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { getAnalyticsView } from '@/lib/analytics/view';

/**
 * The phone's read of `/analytics` — the same walk the web page uses,
 * `getAnalyticsView`, with nothing re-derived on the way out.
 *
 * The web screen is deliberately server-rendered with no REST route of its
 * own (see the comment on `src/app/(app)/analytics/page.tsx`). That is
 * why this one exists: a native client has nothing to call otherwise, and
 * a second walk over the same transactions would be two opinions about
 * what the portfolio returned.
 *
 * `?p=` scopes to a portfolio and is resolved inside the shared view: a
 * malformed, foreign or deleted id degrades to All rather than erroring,
 * so the parameter cannot enumerate anything. Same rule as `/dividends`.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const url = new URL(request.url);
  const view = await getAnalyticsView(userId, url.searchParams.get('p') ?? undefined);

  return jsonOk(analyticsResponseSchema.parse(view));
}
