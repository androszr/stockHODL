import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db, priceAlertState } from '@/lib/db';
import type { Money } from '@/lib/money';

import { type AlertDirection, type AlertStateTransition, nextAlertState } from './dedupe';

/**
 * Reads one (instrument, direction) alert state and computes its transition.
 * Deliberately does NOT persist: a disarm must not outlive the push that
 * justified it. `/api/cron/check-price-alerts` commits the result through
 * `commitAlertState` — after a delivery when the transition fires, immediately
 * when it does not. The transition logic itself lives in `nextAlertState`
 * (`./dedupe.ts`) so it can be tested without a database.
 */
export async function evaluateAlert(
  instrumentId: string,
  direction: AlertDirection,
  movePct: Money,
): Promise<AlertStateTransition> {
  const [existing] = await db
    .select({ armed: priceAlertState.armed })
    .from(priceAlertState)
    .where(
      and(eq(priceAlertState.instrumentId, instrumentId), eq(priceAlertState.direction, direction)),
    )
    .limit(1);

  return nextAlertState(existing?.armed ?? null, movePct);
}

/**
 * Persists a transition. Split from `evaluateAlert` so a firing transition can
 * be held back until APNs actually accepted the alert: writing `armed: false`
 * before the send meant an undelivered crossing was consumed for good — the
 * symbol would then stay silent until it retraced under `RESET_THRESHOLD` and
 * crossed again. That is not hypothetical, since an unconfigured APNs key
 * degrades every send to `'error'`.
 */
export async function commitAlertState(
  instrumentId: string,
  direction: AlertDirection,
  armed: boolean,
  fired: boolean,
  now: Date,
): Promise<void> {
  await db
    .insert(priceAlertState)
    .values({
      instrumentId,
      direction,
      armed,
      lastFiredAt: fired ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [priceAlertState.instrumentId, priceAlertState.direction],
      set: {
        armed,
        ...(fired ? { lastFiredAt: now } : {}),
        updatedAt: now,
      },
    });
}
