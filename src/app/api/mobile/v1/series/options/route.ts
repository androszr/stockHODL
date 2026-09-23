import { optionsRangeQuerySchema } from '@/lib/api/contracts';
import { jsonOk, parseQuery, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { emptySeries } from '@/lib/charts/series';
import { optionContractSeries, userOptionsSeries } from '@/lib/options/portfolio-series';

/**
 * The options value series in USD — the endpoint twin of the
 * `getOptionsSeries` / `getOptionContractSeries` Server Actions, over the same
 * shared body (`src/lib/options/portfolio-series.ts`).
 *
 * `?ticker=` narrows to ONE contract's own marks, for the contract detail
 * screen; without it the series is the whole tracked book. It is the OCC
 * TICKER, not the card `key` — a card can be a `ticker#rowId` group, which
 * matches no row. Both are scoped to
 * the caller's own lots inside the shared body, so a well-formed ticker the
 * user does not track charts nothing — and answers the same empty payload a
 * tracked-but-unrecorded contract does. Nothing here is an oracle.
 *
 * The FIVE ranges are `OPTIONS_CHART_RANGES`, not the eight the portfolio
 * chart offers: the marks are daily by construction, so `1D`/`5D` would be a
 * tab that always draws nothing.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const query = parseQuery(request, optionsRangeQuerySchema);
  if (!query.ok) return query.response;

  try {
    const { range, ticker } = query.data;
    return jsonOk(
      ticker === undefined
        ? await userOptionsSeries(userId, range)
        : await optionContractSeries(userId, ticker, range),
    );
  } catch (error) {
    // The web actions can only ever answer with a payload; a 500 here would
    // give the phone a failure mode the web does not have.
    const message = error instanceof Error ? error.message : 'options series failed';
    console.error(`Mobile options series failed: ${message}`);
    return jsonOk(emptySeries());
  }
}
