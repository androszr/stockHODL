import { newsFeedResponseSchema } from '@/lib/api/contracts';
import { jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { loadNewsFeed, loadTickerNews } from '@/lib/news/feed';

/** Matches the web list's page size; the phone's section shows fewer. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * The news feed for the user's own symbols — the bearer read of `/news`.
 *
 * `?ticker=` filters to ONE symbol and its authorization is not this route's:
 * `loadTickerNews` re-validates the symbol against the user's own sources and
 * returns null for anything outside them, which we answer as the ordinary
 * unfiltered feed — the `resolvePortfolioScope` precedent. So the parameter
 * can neither run an arbitrary-symbol vendor query nor act as an existence
 * oracle, and "exists but not yours" is indistinguishable from "unknown".
 *
 * `degraded` is a field, not an error: the loader never throws to a caller,
 * and stored-but-stale rows with an honest caption beat an empty screen.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const ticker = url.searchParams.get('ticker');
  if (ticker !== null && ticker.length > 0 && ticker.length <= 20) {
    const scoped = await loadTickerNews(userId, ticker, limit);
    if (scoped !== null) {
      return jsonOk(
        newsFeedResponseSchema.parse({
          articles: scoped.articles,
          omitted: [],
          degraded: scoped.degraded,
        }),
      );
    }
  }

  const feed = await loadNewsFeed(userId, limit);
  return jsonOk(newsFeedResponseSchema.parse(feed));
}
