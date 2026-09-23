import {
  jsonOk,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { getHoldingsView } from '@/lib/holdings/live-view';
import { listPortfolios } from '@/lib/portfolios/mutations';
import { listWatchlist } from '@/lib/watchlist/mutations';

/**
 * ONE call for a cold start: portfolios, the static half of the holdings
 * view, the watchlist, and the live payload.
 *
 * Why one call and not four: on a phone the round trip dominates, and the
 * pieces are useless apart — a card cannot paint without both its static and
 * its live half. It is also what lets the client write a single snapshot to
 * the App Group container and repaint from it instantly next launch.
 *
 * The three loads run CONCURRENTLY. `getHoldingsView` is the expensive one
 * (DB join → provider quotes → NBP FX → market status) and is already
 * best-effort internally: quote, FX and status failures degrade the payload —
 * cost-only cards, "—" summary, derived market status — rather than throwing.
 * The other two are plain DB reads. `Promise.all` is therefore safe here for
 * the same reason it is in `loadInstrumentInputs`: no member can reject
 * without that being a genuine failure of the whole call.
 *
 * Deliberately NO query parameters, on the `/api/quotes` rule: the symbol set
 * always comes from the caller's own rows, never from the request. Every
 * scope ships in the payload and the client SELECTS one — it never asks for
 * one.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const [view, portfolios, watchlist] = await Promise.all([
    getHoldingsView(userId),
    listPortfolios(userId),
    listWatchlist(userId),
  ]);

  return jsonOk({
    portfolios,
    staticHoldings: view.staticHoldings,
    scopes: view.scopes,
    watchlist,
    live: view.live,
  });
}
