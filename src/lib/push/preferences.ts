import 'server-only';

import { eq } from 'drizzle-orm';

import { db, notificationPreferences, user } from '@/lib/db';

/**
 * The `server-only` owner of the `notification_preferences` table
 * (plans/2026-09-05-daily-portfolio-summary-push.md).
 *
 * A missing row means both preferences are OFF — uniformly, with no
 * token-exists fallback: the backfill migration inserted `price_alerts = true`
 * for every user already holding a push token, so that special case never
 * needs to exist. Booleans and a calendar date only; no money columns.
 */

export interface NotificationPreferencesRow {
  priceAlerts: boolean;
  dailySummary: boolean;
}

/** The two switches, as the account remembers them. Missing row → both false. */
export async function getNotificationPreferences(
  userId: string,
): Promise<NotificationPreferencesRow> {
  const rows = await db
    .select({
      priceAlerts: notificationPreferences.priceAlerts,
      dailySummary: notificationPreferences.dailySummary,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  return rows[0] ?? { priceAlerts: false, dailySummary: false };
}

/** Upsert on `userId` — the PUT handler's whole body. */
export async function setNotificationPreferences(
  userId: string,
  prefs: NotificationPreferencesRow,
): Promise<void> {
  await db
    .insert(notificationPreferences)
    .values({ userId, priceAlerts: prefs.priceAlerts, dailySummary: prefs.dailySummary })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: {
        priceAlerts: prefs.priceAlerts,
        dailySummary: prefs.dailySummary,
        updatedAt: new Date(),
      },
    });
}

export interface DayReportUser {
  userId: string;
  /** The "Daily summary" switch — governs BOTH pushes, never the reports. */
  dailySummary: boolean;
  /** NY-calendar ISO date of the last DELIVERED summary, or null. */
  dailySummaryLastSentDay: string | null;
  morningBriefLastSentDay: string | null;
}

/**
 * Every account, with its push switch and never-twice markers. The day-report
 * crons walk this list, not the opted-in subset: a report is written for the
 * account whether or not a push is wanted, because the Day Report screen and
 * the Dashboard history read the same row. Gating the walk on the switch
 * (the original shape) meant a user with pushes off never got a morning
 * report generated at all. A missing preferences row means the switch is off.
 */
export async function listDayReportUsers(): Promise<DayReportUser[]> {
  const rows = await db
    .select({
      userId: user.id,
      dailySummary: notificationPreferences.dailySummary,
      dailySummaryLastSentDay: notificationPreferences.dailySummaryLastSentDay,
      morningBriefLastSentDay: notificationPreferences.morningBriefLastSentDay,
    })
    .from(user)
    .leftJoin(notificationPreferences, eq(notificationPreferences.userId, user.id));
  return rows.map((row) => ({
    userId: row.userId,
    dailySummary: row.dailySummary ?? false,
    dailySummaryLastSentDay: row.dailySummaryLastSentDay,
    morningBriefLastSentDay: row.morningBriefLastSentDay,
  }));
}

export async function markMorningBriefSent(userId: string, dayISO: string): Promise<void> {
  await db
    .update(notificationPreferences)
    .set({ morningBriefLastSentDay: dayISO, updatedAt: new Date() })
    .where(eq(notificationPreferences.userId, userId));
}

/**
 * Records the day a summary was actually DELIVERED (at least one APNs
 * `delivered` outcome — the check-price-alerts doctrine). A run where every
 * token errored never calls this, so the marker never claims a summary
 * nobody received.
 */
export async function markDailySummarySent(userId: string, dayISO: string): Promise<void> {
  await db
    .update(notificationPreferences)
    .set({ dailySummaryLastSentDay: dayISO, updatedAt: new Date() })
    .where(eq(notificationPreferences.userId, userId));
}
