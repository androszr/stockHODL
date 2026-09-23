import { notificationPreferencesSchema } from '@/lib/api/contracts';
import { jsonOk, parseJsonBody, unauthorized } from '@/lib/api/mobile/respond';
import { sessionUserId } from '@/lib/api/mobile/session';
import { getNotificationPreferences, setNotificationPreferences } from '@/lib/push/preferences';

/**
 * The two Settings switches, server-stored
 * (plans/2026-09-05-daily-portfolio-summary-push.md). A missing row answers
 * both-off — the uniform meaning `preferences.ts` documents. Deliberately its
 * own endpoint rather than a field on `/api/mobile/v1/settings`, which pays
 * for an uncached vendor probe on every read.
 */

export async function GET(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  return jsonOk(await getNotificationPreferences(userId));
}

export async function PUT(request: Request) {
  const userId = await sessionUserId(request);
  if (!userId) return unauthorized();

  const body = await parseJsonBody(request, notificationPreferencesSchema);
  if (!body.ok) return body.response;

  await setNotificationPreferences(userId, body.data);
  return jsonOk({ ok: true });
}
