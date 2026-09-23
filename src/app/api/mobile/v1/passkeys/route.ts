import { passkeysResponseSchema } from '@/lib/api/contracts';
import { jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { listPasskeys } from '@/lib/passkeys/manage';

/**
 * The enrolled passkeys, for the phone's Profile screen — the bearer twin of
 * what `PasskeyManager` renders server-side on `/settings`. Same body
 * (`src/lib/passkeys/manage.ts`), so the two lists cannot disagree about
 * which keys exist or whether one may go.
 *
 * READ ONLY here plus the delete next door. Enrolling a new key from the
 * phone is a WebAuthn registration ceremony, not a JSON write, and stays on
 * the web for now (docs/ios-native.md, "NIE w v1").
 */
export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const items = await listPasskeys(userId);

  return jsonOk(
    passkeysResponseSchema.parse({
      items,
      // The server's verdict, not a count for the client to re-read: the
      // never-the-last-one rule has exactly one implementation.
      canRemove: items.length > 1,
    }),
  );
}
