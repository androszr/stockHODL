import { jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { loadMarketStrip } from '@/lib/market-strip/load';

/**
 * The Dashboard's market index strip — S&P 500, Nasdaq and Dow, each via the
 * ETF that tracks it (the real index feeds are NOT_ENTITLED on this plan, and
 * the payload names the fund on every tile).
 *
 * Session-guarded like every `/api/mobile/v1/*` door, and deliberately
 * parameterless — nothing in the URL is read at all. The symbol set is a
 * server-side constant inside `loadMarketStrip`, so this cannot become an open
 * quote proxy for whoever holds a token, and no caller can steer it at a
 * symbol this plan is not entitled to.
 *
 * Poll-only, no SSE twin: the figures are 15-minute delayed and the spark
 * grows one bar per five minutes, so a 60 s poll gated on the market being
 * open is the whole cadence. `private, no-store` comes from `jsonOk`.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  return jsonOk(await loadMarketStrip());
}
