import { eq } from 'drizzle-orm';

import { cronGate } from '@/lib/api/cron/gate';
import { db, pushTokens } from '@/lib/db';
import { buildFactsForNarrative } from '@/lib/day-report/view';
import { ensureDayReportNarrative } from '@/lib/day-report/narrative-store';
import { dayReportIsComplete, dayReportPushMayGo } from '@/lib/day-report/readiness';
import { env } from '@/lib/env';
import { readStoredCalendar } from '@/lib/market-data/calendar-store';
import { sendPushAlert } from '@/lib/push/apns';
import { morningBriefDayToSend } from '@/lib/push/daily-summary';
import { composeMorningBriefAlert } from '@/lib/push/morning-brief';
import { listDayReportUsers, markMorningBriefSent } from '@/lib/push/preferences';
import { pruneInvalidTokens } from '@/lib/push/tokens';

/**
 * The pre-open Morning brief push: writes every account's morning report,
 * then pushes it to opted-in users. Vercel Cron target (`vercel.json`,
 * weekdays at 12:30, 12:45, 13:00 and 13:15 UTC — all before the 13:30 UTC
 * summer open, because `morningBriefDayToSend` answers only while
 * `now < open`; in winter the open is 14:30 UTC and every slot qualifies).
 *
 * The push waits for the report it deep-links to
 * (plans/2026-09-23-report-push-waits-for-report.md), mirroring the closing
 * route: a run whose morning report is not complete (`dayReportIsComplete`:
 * `ready` or `refused`) sends nothing, writes no marker and counts the user
 * in `notReady`, so the next slot retries; a morning whose report never
 * completes has no brief that day. `not_configured` (no writer key) is the
 * exception: no report is coming, so the recap line goes out alone
 * (`dayReportPushMayGo`).
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  const refused = cronGate(request, env().CRON_SECRET);
  if (refused) return refused;

  try {
    const calendar = await readStoredCalendar();
    const dayISO = morningBriefDayToSend(Date.now(), calendar.overrides);
    if (dayISO === null) {
      return Response.json({ ok: true, skipped: 'not-before-open' }, { headers: NO_STORE });
    }
    let sent = 0;
    let reports = 0;
    let notReady = 0;
    const invalidTokens = new Set<string>();
    // Every account, not just the opted-in ones: the report is written first
    // and unconditionally, the push is the optional second half. Gating the
    // whole loop on the switch left an account with pushes off without any
    // morning report at all.
    for (const user of await listDayReportUsers()) {
      try {
        const built = await buildFactsForNarrative(user.userId, dayISO, null, 'morning');
        if (built === null) continue;
        const { facts } = built;
        const narrative = await ensureDayReportNarrative(user.userId, dayISO, null, 'morning').catch(
          (error) => {
            const message = error instanceof Error ? error.message : 'narrative failed';
            console.error(`[cron/morning-brief] narrative ${user.userId}: ${message}`);
            return null;
          },
        );
        const complete = dayReportIsComplete(narrative);
        if (complete) reports++;

        if (!user.dailySummary || user.morningBriefLastSentDay === dayISO) continue;
        // The push deep-links to the morning report: hold it — no send, no
        // marker — until that report is complete, so a later slot retries.
        // `not_configured` (no writer key) goes out: no report is coming.
        if (!dayReportPushMayGo(narrative)) {
          notReady++;
          console.warn(
            `[cron/morning-brief] held ${user.userId}: report ${narrative?.status ?? 'failed'}`,
          );
          continue;
        }
        const tokenRows = await db
          .select({ token: pushTokens.token })
          .from(pushTokens)
          .where(eq(pushTokens.userId, user.userId));
        const tokens = tokenRows.map((row) => row.token);
        if (tokens.length === 0) continue;

        const alert = composeMorningBriefAlert({
          recap: facts.recap,
          todayLine: narrative?.status === 'ready' ? narrative.todayLine : null,
          dayISO,
        });
        if (alert === null) continue;
        const outcomes = await sendPushAlert(tokens, alert);
        for (const [token, outcome] of outcomes) {
          if (outcome === 'invalid-token') invalidTokens.add(token);
        }
        if ([...outcomes.values()].includes('delivered')) {
          sent++;
          await markMorningBriefSent(user.userId, dayISO);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'brief failed';
        console.error(`[cron/morning-brief] user ${user.userId}: ${message}`);
      }
    }
    if (invalidTokens.size > 0) await pruneInvalidTokens([...invalidTokens]);
    return Response.json({ ok: true, day: dayISO, reports, sent, notReady }, { headers: NO_STORE });
  } catch (error) {
    console.error('[cron/morning-brief]', error);
    return Response.json({ error: 'Brief failed.' }, { status: 502, headers: NO_STORE });
  }
}
