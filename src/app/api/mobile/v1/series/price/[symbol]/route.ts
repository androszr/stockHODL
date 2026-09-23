import { priceSeriesQuerySchema, symbolParamSchema } from '@/lib/api/contracts';
import {
  jsonOk,
  parseQuery,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { emptySeries } from '@/lib/charts/series';
import { userPriceSeriesBySymbol } from '@/lib/history/user-series';

/**
 * Price series for one instrument, addressed by symbol — what the native
 * instrument screen already holds.
 *
 * An unknown ticker, a ticker the user neither owns nor watches, and a
 * malformed one all produce the SAME empty payload. Never a 404: a series
 * that answers differently for "exists but not yours" would enumerate the
 * global `instruments` table one request at a time.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const query = parseQuery(request, priceSeriesQuerySchema);
  if (!query.ok) return query.response;

  const symbol = symbolParamSchema.safeParse(decodeURIComponent((await params).symbol));
  if (!symbol.success) return jsonOk(emptySeries());

  try {
    return jsonOk(await userPriceSeriesBySymbol(userId, symbol.data, query.data.range));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'price series failed';
    console.error(`Mobile price series failed: ${message}`);
    return jsonOk(emptySeries());
  }
}
