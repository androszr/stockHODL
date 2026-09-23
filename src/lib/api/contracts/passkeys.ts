import { z } from 'zod';

/**
 * Passkey contracts — the enrolled-credential list, read-only from the
 * phone's side apart from the delete.
 *
 * Nothing secret crosses this wire. `publicKey`, `credentialID`, `counter`
 * and `transports` all stay on the server: none of them helps a Profile
 * screen say which device this is, and a credential id in a JSON body is a
 * correlation handle for no benefit. What ships is what the list actually
 * renders.
 */

export const passkeyItemSchema = z.object({
  id: z.string(),
  /** Null for a key enrolled before naming existed, or named as nothing. */
  name: z.string().nullable(),
  /**
   * The plugin's own vocabulary, passed through rather than mapped to a
   * boolean: `'multiDevice'` means the credential syncs through a keychain
   * and survives losing the phone. Both clients turn it into the same words.
   */
  deviceType: z.string(),
  backedUp: z.boolean(),
  createdAtISO: z.string().nullable(),
});

export type PasskeyItemContract = z.output<typeof passkeyItemSchema>;

export const passkeysResponseSchema = z.object({
  items: z.array(passkeyItemSchema),
  /**
   * Whether removing one is possible AT ALL right now — the server's own
   * verdict, not a count the client re-interprets. The rule ("never the last
   * one") lives in `src/lib/passkeys/manage.ts`, and a client deriving it
   * from `items.length` would be a second copy of a lockout rule.
   */
  canRemove: z.boolean(),
});

export type PasskeysResponseContract = z.output<typeof passkeysResponseSchema>;
