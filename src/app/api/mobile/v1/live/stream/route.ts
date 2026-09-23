import { unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { composeLivePayload } from '@/lib/holdings/live-payload';
import { loadHoldingsInputs } from '@/lib/holdings/live-view';
import { quoteStreamResponse } from '@/lib/holdings/stream-response';

/**
 * The SSE twin of `/api/mobile/v1/live`, and the bearer-authenticated mirror
 * of `/api/quotes/stream`. It exists for the same reason its sibling does: the
 * `src/proxy.ts` cookie gate only excuses `/api/mobile/`, so the web stream
 * route is unreachable for a client that authenticates with a header.
 *
 * Everything about the stream itself — protocol, races, bounded lifetime, the
 * `idle` / `payload` / `fallback` / `bye` events — lives in
 * `quoteStreamResponse` and is shared verbatim with the web route. This file
 * is the guard, the loader and the composer, nothing else.
 *
 * `maxDuration` matches the web route: Vercel caps the function anyway, which
 * is precisely why the client must treat a clean end-of-stream as normal and
 * reconnect rather than as an error.
 */

export const maxDuration = 300;

export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  // The baseline: one fresh REST walk (DB → quotes → FX → status).
  const { inputs, quotes } = await loadHoldingsInputs(userId);

  return quoteStreamResponse(request, {
    status: inputs.market.status,
    pollingResumesAtMs: inputs.market.pollingResumesAtMs,
    hasPollableSymbols: inputs.hasPollableSymbols,
    quotes,
    compose: (q) => composeLivePayload(inputs, q),
  });
}
