import { cronGate } from '@/lib/api/cron/gate';
import { env } from '@/lib/env';
import { refreshSymbolDirectory } from '@/lib/market-data/symbol-directory';

/**
 * Vercel Cron target (see vercel.json): re-downloads the Nasdaq Trader symbol
 * directory once a day. Internet-reachable, so it authenticates with
 * `Authorization: Bearer ${CRON_SECRET}` — the header Vercel Cron sends when
 * the env var is set.
 *
 * The check itself is the shared `cronGate` (`src/lib/api/cron/gate.ts`):
 * 503 without a configured secret, 401 on any other header, and error bodies
 * that tell strangers nothing.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  const refused = cronGate(request, env().CRON_SECRET);
  if (refused) return refused;

  try {
    const { upserted, deleted } = await refreshSymbolDirectory();
    return Response.json({ ok: true, upserted, deleted }, { headers: NO_STORE });
  } catch (error) {
    console.error('[cron/refresh-symbols]', error);
    return Response.json({ error: 'Refresh failed.' }, { status: 502, headers: NO_STORE });
  }
}
