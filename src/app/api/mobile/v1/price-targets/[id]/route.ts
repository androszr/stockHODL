import { deleteTarget } from '@/lib/alerts/target-store';
import { uuidSchema } from '@/lib/api/contracts';
import { badRequest, jsonOk, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';

/**
 * Delete a price target. Idempotent by decision, the watchlist-delete
 * precedent: an absent target IS the requested end state, so a foreign or
 * unknown id deletes nothing and still answers ok — nothing here is
 * enumerable. Answers the affected instrument's fresh list (empty when
 * nothing was deleted, since no instrument is then knowable).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return badRequest('Invalid target.');

  const { targets, status } = await deleteTarget(userId, id.data);
  return jsonOk({ targets, status });
}
