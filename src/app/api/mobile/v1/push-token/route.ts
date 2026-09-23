import { pushTokenRequestSchema } from '@/lib/api/contracts';
import { jsonOk, parseJsonBody, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { registerPushToken, unregisterPushToken } from '@/lib/push/tokens';

/**
 * Device push-token registration for the price-move alert
 * (plans/2026-08-20-price-move-push-alerts.md). `DELETE` is what the
 * Settings toggle calls on disable and what sign-out calls alongside the
 * Keychain purge, so a signed-out or opted-out device stops being pushed to.
 */

export async function POST(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, pushTokenRequestSchema);
  if (!body.ok) return body.response;

  await registerPushToken(userId, body.data.token, body.data.environment);
  return jsonOk({ ok: true });
}

export async function DELETE(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, pushTokenRequestSchema);
  if (!body.ok) return body.response;

  await unregisterPushToken(userId, body.data.token);
  return jsonOk({ ok: true });
}
