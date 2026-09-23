import 'server-only';

import { and, count, desc, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { passkey } from '@/lib/db/schema';

/**
 * The passkey list and its one destructive operation, owned here rather than
 * in a component — the Settings page and the phone's Profile screen both ask
 * the same two questions, and this is a table where two answers is a lockout.
 *
 * Read straight from OUR table rather than through the plugin's HTTP
 * endpoint: it is our schema, the query is trivially scoped by `userId`, and
 * it keeps the web list server-rendered instead of a client fetch.
 *
 * Not a `mutations.ts` beside a `list.ts`, deliberately — the delete rule is
 * a fact ABOUT the list ("not the last one"), and splitting the two across
 * files is how a caller ends up deleting without having counted.
 */

export interface PasskeyRow {
  id: string;
  name: string | null;
  /** `'multiDevice'` = synced through a keychain; anything else is device-bound. */
  deviceType: string;
  backedUp: boolean;
  /** ISO instant, or null on rows predating the column default. */
  createdAtISO: string | null;
}

/**
 * A refusal carries a REASON as well as a sentence: the two failures mean
 * different things to an HTTP caller (one is 409, the other 404) and matching
 * on the message text to tell them apart is a bug waiting for a reword.
 */
export type PasskeyMutation =
  | { ok: true }
  | { ok: false; reason: 'last-key' | 'not-found'; error: string };

/** Newest first — the one just added is the one being looked for. */
export async function listPasskeys(userId: string): Promise<PasskeyRow[]> {
  const rows = await db
    .select({
      id: passkey.id,
      name: passkey.name,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
      createdAt: passkey.createdAt,
    })
    .from(passkey)
    .where(eq(passkey.userId, userId))
    .orderBy(desc(passkey.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAtISO: row.createdAt?.toISOString() ?? null,
  }));
}

/**
 * Remove one key, and REFUSE to remove the last.
 *
 * This app is passkey-only with no password fallback (`src/lib/auth.ts`), so
 * deleting the final credential does not degrade the account — it ends
 * access to it, recoverable only by `scripts/recover.ts` against the
 * database. The web has always disabled that button at one key remaining, but
 * a disabled button is a hint, not a rule: it is absent from the phone, from
 * a second tab holding a stale list, and from anything that calls the plugin
 * endpoint directly. The rule belongs where the row is actually deleted.
 *
 * NOT idempotent, unlike the watchlist delete. An unknown or foreign id is a
 * refusal rather than a cheerful `ok`: "your key is gone" is the one answer
 * that must never be a lie about a key that is still enrolled.
 *
 * Count-then-delete is not atomic — the neon-http driver has no interactive
 * transaction — so two deletes racing on the last two keys could in principle
 * both pass the count. It takes one user issuing two different deletes in the
 * same instant on two devices; this app has exactly one user, forever
 * (non-negotiable #5), and the recovery script exists for the case where it
 * happens anyway.
 */
export async function deletePasskey(
  userId: string,
  id: string,
): Promise<PasskeyMutation> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(passkey)
    .where(eq(passkey.userId, userId));

  if (total <= 1) {
    return {
      ok: false,
      reason: 'last-key',
      error: 'This is your only passkey — add another before removing it.',
    };
  }

  // Scoped by userId as well as id: the id is the caller's to name, and
  // nothing else here would stop it naming somebody else's row.
  const deleted = await db
    .delete(passkey)
    .where(and(eq(passkey.id, id), eq(passkey.userId, userId)))
    .returning({ id: passkey.id });

  if (deleted.length === 0) {
    return { ok: false, reason: 'not-found', error: 'Passkey not found.' };
  }
  return { ok: true };
}
