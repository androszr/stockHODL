import { portfolioSeriesQuerySchema } from '@/lib/api/contracts';
import {
  jsonOk,
  parseQuery,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { emptySeries } from '@/lib/charts/series';
import { userPortfolioSeries } from '@/lib/history/user-series';

/**
 * Portfolio value in PLN over one of the eight ranges — the endpoint twin of
 * the `getPortfolioSeries` Server Action, over the same shared body.
 *
 * A bad range is a malformed request and gets a 400; a bad SCOPE is not — a
 * foreign, malformed or deleted portfolio id resolves to the all-portfolios
 * series, exactly as it does on the web. That asymmetry is deliberate: the
 * range is ours to define, the scope is a user-held id whose staleness must
 * never leak whether the row exists.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const query = parseQuery(request, portfolioSeriesQuerySchema);
  if (!query.ok) return query.response;

  try {
    return jsonOk(
      await userPortfolioSeries(userId, query.data.range, query.data.portfolioId),
    );
  } catch (error) {
    // The web action can only ever answer with a payload; a 500 here would
    // give the phone a failure mode the web does not have.
    const message = error instanceof Error ? error.message : 'portfolio series failed';
    console.error(`Mobile portfolio series failed: ${message}`);
    return jsonOk(emptySeries());
  }
}
