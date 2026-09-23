import { uuidSchema } from '@/lib/api/contracts';
import {
  badRequest,
  jsonError,
  jsonOk,
  notFound,
  parseJsonBody,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { deleteDividendFor, updateDividendFor } from '@/lib/dividends/mutations';
import { dividendUpdateSchema } from '@/lib/dividends/validation';

/**
 * Correct or remove one dividend payment.
 *
 * The instrument and the currency are NOT editable — a different company or a
 * different currency is a different payment (the transaction instrument-lock
 * precedent; delete plus re-add is the path). `dividendUpdateSchema` states
 * that, and it is the same schema the web edit form submits through.
 *
 * A `PATCH` marks the row `edited`, after which no vendor refresh ever
 * touches it again; a `DELETE` of a vendor-sourced row TOMBSTONES it, so the
 * next sync cannot quietly re-create what the user removed. Both rules live
 * in `src/lib/dividends/store.ts` — this handler only establishes who is
 * asking.
 */

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return badRequest('Invalid payment.');

  const body = await parseJsonBody(request, dividendUpdateSchema);
  if (!body.ok) return body.response;

  const result = await updateDividendFor(userId, id.data, body.data);
  if (!result.ok) {
    // "Not found" covers a missing row and a foreign one alike — the
    // ownership scoping makes them literally the same code path. The
    // portfolio lock is a conflict the user can act on, and says so.
    return result.error === 'Payment not found.'
      ? notFound(result.error)
      : jsonError(result.error, 409);
  }

  return jsonOk({ ok: true });
}

export async function DELETE(request: Request, { params }: Params) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return badRequest('Invalid payment.');

  const result = await deleteDividendFor(userId, id.data);
  if (!result.ok) return notFound(result.error);

  return jsonOk({ ok: true });
}
