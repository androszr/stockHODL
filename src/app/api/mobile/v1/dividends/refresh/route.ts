import { jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { refreshDividendsFor } from '@/lib/dividends/mutations';

/**
 * Re-ask the vendor now — the phone's twin of the web's Refresh button.
 *
 * Its own route rather than a method on the collection: it writes nothing the
 * caller supplied and takes no body, and a POST to `/dividends` already means
 * "add this payment".
 *
 * Always 200. `syncDividends` is best-effort end to end and never throws — a
 * vendor that did not answer leaves the ledger exactly as it was, which is
 * indistinguishable from a sync that found nothing new. The client reloads
 * the list afterwards and sees whatever actually landed.
 */
export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  await refreshDividendsFor(userId);
  return jsonOk({ ok: true });
}
