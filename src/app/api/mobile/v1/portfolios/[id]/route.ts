import { portfolioRenameSchema, uuidSchema } from '@/lib/api/contracts';
import {
  badRequest,
  jsonError,
  jsonOk,
  notFound,
  parseJsonBody,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { deletePortfolio, renamePortfolio } from '@/lib/portfolios/mutations';

/**
 * Rename and delete for one portfolio.
 *
 * "Not found" is the answer for a foreign id as much as for a missing one —
 * the shared mutations scope every statement by `portfolios.userId`, so the
 * two cases are literally the same code path and nothing is enumerable.
 */

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return badRequest('Invalid portfolio.');

  const body = await parseJsonBody(request, portfolioRenameSchema);
  if (!body.ok) return body.response;

  const result = await renamePortfolio(userId, id.data, body.data.name);
  if (!result.ok) {
    // The mutation answers "not found" for a missing/foreign row and a
    // duplicate-name refusal otherwise — the only two failures it has.
    return result.error === 'Portfolio not found.'
      ? notFound(result.error)
      : jsonError(result.error, 409);
  }

  return jsonOk({ ok: true });
}

export async function DELETE(request: Request, { params }: Params) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return badRequest('Invalid portfolio.');

  // Destructive by design: the FK cascade removes this portfolio's
  // transactions. The confirmation (with the row count) is the client's job,
  // exactly as it is the web UI's.
  const result = await deletePortfolio(userId, id.data);
  if (!result.ok) return notFound(result.error);

  return jsonOk({ ok: true });
}
