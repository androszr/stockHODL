import { jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { loadWidgetSummary } from '@/lib/widgets/load';

/**
 * Everything a WidgetKit timeline entry paints, in about four hundred bytes.
 *
 * This is a PROJECTION of `/live` and `/options`, not a third view of the
 * data: both halves come from the same functions those routes call, so a
 * change to how a total is computed reaches the widget with no second edit.
 * The reason it exists at all is the caller — a widget extension is woken by
 * the system on a metered refresh budget, under a memory limit, and would
 * otherwise pay for every holding, every cached price, every scope and a full
 * per-lot greeks load to render two numbers and two percentages.
 *
 * The two loads run CONCURRENTLY and neither is caught. A failure here answers
 * 5xx and the widget repaints its last App Group snapshot with the age
 * attached — which is a better answer than a synthesised empty summary, and
 * avoids this file growing a second way to construct a total.
 *
 * `market` comes from the holdings view. Both payloads carry a `LiveMarket`
 * built by the same `fetchMarketStatusBestEffort`, so picking one is a choice
 * of source, not of value.
 *
 * Deliberately NO query parameters, on the `/api/quotes` rule: the symbol set
 * always comes from the caller's own rows. The widget gets the top-level
 * total and cannot ask for a portfolio scope — the scope selector is a client
 * concern that a system-woken renderer has no session state to express.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  return jsonOk(await loadWidgetSummary(userId));
}
