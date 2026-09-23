import { marketSeriesKeyParamSchema, priceSeriesQuerySchema } from '@/lib/api/contracts';
import { jsonOk, parseQuery, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { emptySeries } from '@/lib/charts/series';
import { marketStripSeries } from '@/lib/market-strip/series';

/**
 * The chart behind one market tile — SPY, QQQ, DIA or USDPLN, and nothing
 * else. The key is validated against the CLOSED enum before anything is
 * resolved: an unknown key is the empty payload with no vendor or database
 * call, which is what keeps this from becoming a way to chart arbitrary
 * tickers. Same refusal shape as every series door — never a 404.
 *
 * Session-guarded, `private, no-store` from `jsonOk`, and three lines of
 * logic like every `/api/mobile/v1/*` handler.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const query = parseQuery(request, priceSeriesQuerySchema);
  if (!query.ok) return query.response;

  const key = marketSeriesKeyParamSchema.safeParse(decodeKey((await params).key));
  if (!key.success) return jsonOk(emptySeries());

  return jsonOk(await marketStripSeries(key.data, query.data.range));
}

/** A malformed percent sequence is just another unknown key, not a 500. */
function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}
