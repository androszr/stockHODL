import { portfolioCreateSchema } from '@/lib/api/contracts';
import {
  jsonOk,
  jsonError,
  parseJsonBody,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { createPortfolio, listPortfolios } from '@/lib/portfolios/mutations';

/**
 * Portfolio list and create for the native client.
 *
 * Both are the same two lines: guard the session, then call the function the
 * Server Action calls. No ownership logic lives here — it lives in
 * `src/lib/portfolios/mutations.ts` and is scoped by `portfolios.userId` in
 * SQL, so a handler cannot forget it.
 */

export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  return jsonOk({ portfolios: await listPortfolios(userId) });
}

export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, portfolioCreateSchema);
  if (!body.ok) return body.response;

  const result = await createPortfolio(userId, body.data.name);
  // A duplicate name is the user's mistake, not a malformed request: 409, so
  // the client can show the refusal verbatim beside the field.
  if (!result.ok) return jsonError(result.error, 409);

  return jsonOk({ ok: true, id: result.id }, 201);
}
