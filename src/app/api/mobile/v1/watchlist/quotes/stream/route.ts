import { unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { quoteStreamResponse } from '@/lib/holdings/stream-response';
import { loadWatchlistInputs } from '@/lib/watchlist/live-view';
import { composeWatchlistPayload } from '@/lib/watchlist/watchlist-payload';

/**
 * The watchlist SSE stream for the native client — the bearer twin of
 * `/api/quotes/watchlist/stream`, over the same `quoteStreamResponse`
 * lifecycle and the same composition.
 *
 * Vercel caps the function, which is why the client treats a clean end as
 * "reconnect" rather than as an error. 300 s matches the holdings stream.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  // The baseline: one fresh walk (watchlist join → quotes → status).
  const { items, inputs, quotes } = await loadWatchlistInputs(userId);

  return quoteStreamResponse(request, {
    status: inputs.market.status,
    pollingResumesAtMs: inputs.market.pollingResumesAtMs,
    hasPollableSymbols: inputs.hasPollableSymbols,
    quotes,
    compose: (q) => composeWatchlistPayload(items, inputs, q),
  });
}
