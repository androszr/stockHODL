import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import { db, pushTokens } from '@/lib/db';

export type PushEnvironment = 'sandbox' | 'production';

/**
 * Register (or re-register) one device. Upserts on the unique `token` column
 * — a reinstalled app or an APNs-rotated token is not an error, it is the
 * same device asking again.
 */
export async function registerPushToken(
  userId: string,
  token: string,
  environment: PushEnvironment,
): Promise<void> {
  await db
    .insert(pushTokens)
    .values({ userId, token, environment })
    .onConflictDoUpdate({
      target: pushTokens.token,
      set: { userId, environment, lastSeenAt: new Date() },
    });
}

/**
 * Scoped delete, called on the Settings toggle turning off and on sign-out.
 * A foreign or unknown token deletes nothing and still succeeds — removal is
 * idempotent, the `removeFromWatchlist` precedent: the requested end state
 * (this device does not have a row) already holds.
 */
export async function unregisterPushToken(userId: string, token: string): Promise<void> {
  await db.delete(pushTokens).where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)));
}

/**
 * Drops tokens APNs itself reported gone for good (410 / `Unregistered` /
 * `BadDeviceToken`). Not user-scoped: the cron route already has the exact
 * token strings it just tried to push to, and a dead token is dead regardless
 * of which user row it was filed under.
 */
export async function pruneInvalidTokens(tokens: readonly string[]): Promise<void> {
  if (tokens.length === 0) return;
  await db.delete(pushTokens).where(inArray(pushTokens.token, tokens));
}
