import { uuidSchema } from '@/lib/api/contracts';
import {
  badRequest,
  jsonOk,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { removeFromWatchlist } from '@/lib/watchlist/mutations';

/**
 * Unwatch. Idempotent by decision — unlike a transaction delete, an absent
 * watch row IS the requested end state, so a foreign or unknown id deletes
 * nothing and still answers ok. Nothing here is enumerable.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ instrumentId: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const id = uuidSchema.safeParse((await params).instrumentId);
  if (!id.success) return badRequest('Invalid instrument.');

  await removeFromWatchlist(userId, id.data);
  return jsonOk({ ok: true });
}
