import { symbolParamSchema } from '@/lib/api/contracts';
import {
  jsonOk,
  notFound,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { loadInstrumentDetail } from '@/lib/instruments/detail';

/**
 * The instrument screen's payload.
 *
 * Any symbol the vendor directory knows resolves here, whether or not the
 * caller owns or watches it — you look at a stock and THEN decide to follow
 * it, and requiring a watchlist row first filled the watchlist with things
 * nobody chose. What ownership decides is the PAYLOAD: transactions give a
 * position, groups and rows, everything else gets identity plus the live
 * figures with `owned` and `watched` false.
 *
 * A malformed symbol and one nothing has ever heard of still get the same
 * 404. That is no longer an ownership refusal — it is the honest answer for a
 * ticker that does not exist, and it is why `instruments` being a global
 * table still costs nothing.
 *
 * Note the deliberate difference from `/series/price/[symbol]`: the series
 * answers a refusal with an EMPTY PAYLOAD rather than a 404, because a chart
 * that 404s would let a caller distinguish "no data" from "not yours". Here
 * there is nothing to distinguish — the whole screen either exists for this
 * user or it does not.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const symbol = symbolParamSchema.safeParse(decodeURIComponent((await params).symbol));
  if (!symbol.success) return notFound();

  const detail = await loadInstrumentDetail(userId, symbol.data);
  if (!detail) return notFound();

  return jsonOk(detail);
}
