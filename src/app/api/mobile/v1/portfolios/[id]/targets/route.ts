import { targetsPutRequestSchema, targetsResponseSchema, uuidSchema } from '@/lib/api/contracts';
import {
  badRequest,
  jsonOk,
  notFound,
  parseJsonBody,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { getTargets, PORTFOLIO_NOT_FOUND, replaceTargets } from '@/lib/targets/store';

/**
 * One portfolio's target weights: read them, or replace the whole list.
 *
 * Three lines each, per doctrine — the ownership check, the instrument
 * check, the atomic rewrite and the analytics-memo invalidation all live in
 * `src/lib/targets/store.ts`. A foreign portfolio id and a missing one are
 * the SAME "not found" answer, because the store scopes every statement by
 * `portfolios.userId` and cannot tell them apart either; nothing here is
 * enumerable.
 */

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return badRequest('Invalid portfolio.');

  const result = await getTargets(userId, id.data);
  if (!result.ok) return notFound(result.error);

  return jsonOk(targetsResponseSchema.parse({ rows: result.rows }));
}

export async function PUT(request: Request, { params }: Params) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return badRequest('Invalid portfolio.');

  const body = await parseJsonBody(request, targetsPutRequestSchema);
  if (!body.ok) return body.response;

  const result = await replaceTargets(userId, id.data, body.data.rows);
  if (!result.ok) {
    // The store's only two failures: an unowned/missing portfolio, and an
    // instrument id that does not exist (refused rather than surfacing as an
    // FK 500 — and it leaks no more than the FK itself would).
    return result.error === PORTFOLIO_NOT_FOUND ? notFound(result.error) : badRequest(result.error);
  }

  return jsonOk({ ok: true });
}
