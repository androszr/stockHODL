import { badRequest, jsonError, jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { deletePasskey } from '@/lib/passkeys/manage';

/**
 * Remove one passkey.
 *
 * Deliberately NOT idempotent — see `deletePasskey`. An unknown id is a 404,
 * because on this table a cheerful `ok` about a key that is still enrolled is
 * the one wrong answer with a security meaning.
 *
 * The last-key refusal comes back as 409: the request was well formed and the
 * caller is who they say they are — the account's state is what forbids it,
 * and the phone shows the server's sentence rather than inventing one.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const { id } = await params;
  // Plugin ids are opaque strings, not uuids — length is the only sane gate.
  if (!id || id.length > 255) return badRequest('Invalid passkey.');

  const result = await deletePasskey(userId, id);
  if (!result.ok) {
    return jsonError(result.error, result.reason === 'not-found' ? 404 : 409);
  }
  return jsonOk({ ok: true });
}
