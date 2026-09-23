import { transactionUpdateSchema, uuidSchema } from '@/lib/api/contracts';
import {
  badRequest,
  jsonError,
  jsonOk,
  notFound,
  parseJsonBody,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { deleteTransaction, updateTransaction } from '@/lib/transactions/mutations';

/**
 * Edit and delete for one transaction.
 *
 * The instrument is LOCKED on edit: the client submits the stored
 * symbol/currency along with the editable fields, and the shared mutation
 * refuses a mismatch rather than rebinding. Changing the instrument is a
 * different trade — the honest path is delete + re-add, and that is the same
 * answer the web form gets.
 */

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return badRequest('Invalid transaction.');

  const body = await parseJsonBody(request, transactionUpdateSchema);
  if (!body.ok) return body.response;

  const result = await updateTransaction(userId, id.data, body.data);
  if (!result.ok) {
    // "Not found" covers a missing row AND a foreign one — the mutation
    // scopes by userId in SQL, so the two are indistinguishable by design.
    return result.error.endsWith('not found.')
      ? notFound(result.error)
      : jsonError(result.error, 409);
  }

  return jsonOk({ ok: true });
}

export async function DELETE(request: Request, { params }: Params) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return badRequest('Invalid transaction.');

  // Unlike the web action, the phone DOES act on the verdict: a client
  // working from a snapshot it wrote before a web-side delete should learn
  // its list is stale rather than believe it just removed something.
  const { deleted } = await deleteTransaction(userId, id.data);
  if (!deleted) return notFound('Transaction not found.');

  return jsonOk({ ok: true });
}
