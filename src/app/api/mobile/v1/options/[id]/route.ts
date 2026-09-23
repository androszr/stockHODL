import { z } from 'zod';

import { optionPositionEditRequestSchema } from '@/lib/api/contracts';
import {
  jsonError,
  jsonOk,
  parseJsonBody,
  unauthorized,
} from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { deleteOptionPosition, editOptionPosition } from '@/lib/options/mutations';

/**
 * One tracked LOT — edit and remove. A card can stand for several
 * `option_positions` rows, so both address a row id and never a card key:
 * a mutation keyed on a card would land on a purchase the user did not name.
 *
 * Both are scoped by `userId` inside the mutation, and both are IDEMPOTENT:
 * a foreign or unknown id changes nothing and still answers ok. That is the
 * web action's behaviour verbatim, and it is deliberate — a 404 here would
 * turn this endpoint into an oracle for whether a given uuid is somebody's
 * option lot.
 */

const idSchema = z.uuid();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const { id } = await params;
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return jsonError('Invalid contract.', 400);

  // The edit schema is STRICT: contract identity (ticker/strike/expiry/type)
  // is refused rather than ignored. Changing the contract is a different
  // position — remove and re-add.
  const body = await parseJsonBody(request, optionPositionEditRequestSchema);
  if (!body.ok) return body.response;

  // The body carries its own id and the schema has already checked it. The
  // path id is what the request addressed, so a mismatch is a malformed
  // request, not a silent preference for one of the two.
  if (body.data.id !== parsedId.data) {
    return jsonError('id: does not match the path.', 400);
  }

  await editOptionPosition(userId, body.data);
  return jsonOk({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const { id } = await params;
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return jsonError('Invalid contract.', 400);

  await deleteOptionPosition(userId, parsedId.data);
  return jsonOk({ ok: true });
}
