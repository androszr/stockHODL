import { settingsResponseSchema } from '@/lib/api/contracts';
import { jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { env } from '@/lib/env';
import { massiveProvider } from '@/lib/market-data/massive';
import { newestFetchedAt } from '@/lib/market-data/quote-cache';

/**
 * The Settings diagnostics — the same two facts `/settings` renders through
 * `MarketDataHealth` and the recovery-mode banner, over the same calls.
 *
 * `checkKeyHealth()` is one direct, UNCACHED vendor probe with its own 5 s
 * timeout, so this handler is comparatively expensive and is meant to be
 * called when a screen opens, never polled. The key itself never appears in
 * the payload, in a log, or in an error — the check lives in `massive.ts` and
 * this route sees only the verdict.
 *
 * Recovery mode is a SERVER fact the device cannot derive. Surfacing it is
 * the whole reason this endpoint exists: while it is on, password sign-in is
 * enabled, and a phone that could not see that would leave the user with no
 * way to learn their account is temporarily easier to reach.
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const [marketData, lastFetched] = await Promise.all([
    massiveProvider.checkKeyHealth(),
    newestFetchedAt(),
  ]);

  return jsonOk(
    settingsResponseSchema.parse({
      marketData,
      // Epoch ms across the wire and formatted on the device, so the phone's
      // own clock and locale apply — the `CachedAsOf` rule.
      lastPriceFetchedAtMs: lastFetched === null ? null : lastFetched.getTime(),
      recoveryMode: env().RECOVERY_MODE,
    }),
  );
}
