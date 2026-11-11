import { z } from 'zod';

/**
 * Notification preferences (plans/2026-09-05-daily-portfolio-summary-push.md)
 * — the two Settings switches as the account remembers them.
 *
 * ONE schema for both directions on purpose: `GET
 * /api/mobile/v1/notification-preferences` answers this shape and `PUT` takes
 * it verbatim (both booleans, always — a partial write would make "which
 * switch did the phone mean" ambiguous). Two booleans, no money, no
 * `open`-style Swift keywords for quicktype to mangle.
 *
 * Deliberately NOT part of `GET /api/mobile/v1/settings`: that handler runs
 * an uncached vendor probe with a 5 s timeout, and a toggle must not wait on
 * one.
 */
export const notificationPreferencesSchema = z.object({
  priceAlerts: z.boolean(),
  dailySummary: z.boolean(),
  /**
   * Whether the morning and close day reports are written at all (off =
   * paused: no report, no push for it). `GET` always answers it. Optional on
   * `PUT` only so a build from before the switch existed, which sends the two
   * push booleans alone, leaves it as it was instead of failing or resetting.
   */
  dayReports: z.boolean().optional(),
});

export type NotificationPreferences = z.output<typeof notificationPreferencesSchema>;
