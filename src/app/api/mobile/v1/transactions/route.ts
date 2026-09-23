import {
  transactionCreateSchema,
  transactionListQuerySchema,
} from '@/lib/api/contracts';
import {
  jsonError,
  jsonOk,
  parseJsonBody,
  parseQuery,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { createTransaction, listTransactions } from '@/lib/transactions/mutations';

/**
 * Transaction list and create.
 *
 * The write body is `transactionInputSchema` — the SAME schema the web form
 * submits through, comma-separator normalization, thousands-grouping refusal,
 * FX-required-for-non-PLN rule and PLN→'1' transform included. The native
 * client therefore cannot get a validation rule the web does not have, and a
 * rule that changes changes for both at once.
 *
 * Amounts come back as the stored `numeric` strings, not display text: the
 * client formats with its own pl-PL formatters, and an edit form needs the
 * stored value rather than a grouped one it would have to parse back.
 */

export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const query = parseQuery(request, transactionListQuerySchema);
  if (!query.ok) return query.response;

  return jsonOk({ transactions: await listTransactions(userId, query.data) });
}

export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, transactionCreateSchema);
  if (!body.ok) return body.response;

  const result = await createTransaction(userId, body.data);
  // Two failures, both conflicts rather than malformed input: an unowned
  // portfolio id, and the currency-mismatch refusal from
  // `resolveOrCreateInstrument` on a globally-bound symbol.
  if (!result.ok) return jsonError(result.error, 409);

  return jsonOk({ ok: true, id: result.id }, 201);
}
