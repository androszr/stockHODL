import { eq } from 'drizzle-orm';

import { cronGate } from '@/lib/api/cron/gate';
import { db, pushTokens } from '@/lib/db';
import { ensureDayReportNarrative } from '@/lib/day-report/narrative-store';
import { dayReportIsComplete, dayReportPushMayGo } from '@/lib/day-report/readiness';
import { env } from '@/lib/env';
import { loadHoldingsInputs } from '@/lib/holdings/live-view';
import { computePortfolioSummary } from '@/lib/holdings/summary';
import { readStoredCalendar } from '@/lib/market-data/calendar-store';
import { computePositions, displayablePositions } from '@/lib/position-engine';
import { sendPushAlert } from '@/lib/push/apns';
import { composeDailySummaryAlert, dailySummaryDayToSend } from '@/lib/push/daily-summary';
import { listDayReportUsers, markDailySummarySent } from '@/lib/push/preferences';
import { pruneInvalidTokens } from '@/lib/push/tokens';

/**
 * The daily portfolio-summary push
 * (plans/2026-09-05-daily-portfolio-summary-push.md): one notification per
 * opted-in user after the US close, saying how the whole portfolio did today
 * in PLN and percent. Vercel Cron target; Vercel attaches
 * `Authorization: Bearer $CRON_SECRET` itself, checked by the shared
 * `cronGate` like every other cron route.
 *
 * The schedule is a retry ladder (`vercel.json`, weekdays, UTC): 20:15,
 * 20:30, 20:45, 21:15, 21:30, 21:45, 22:00, 22:15
 * (plans/2026-09-23-report-push-waits-for-report.md). Cron is UTC-only, so
 * the ladder has to start fifteen minutes after the 16:00 ET close in both
 * halves of the year — 20:15 UTC is 16:15 EDT, 21:15 UTC is 16:15 EST.
 * `dailySummaryDayToSend` skips every slot before the close (20:15, 20:30
 * and 20:45 in winter), and the never-twice marker skips every slot after a
 * delivered push.
 *
 * `21:00 UTC` is deliberately NOT a slot. In winter it is the close instant
 * itself, which `lastCompletedSessionDateISO` counts as completed (`>=`), so
 * the run would build the close figure — and write the close report, which
 * is never regenerated — from 15-minute-delayed quotes ending at 15:45 EST.
 *
 * Honesty over completeness, three times:
 *
 *  - the push waits for the report it deep-links to. A run whose close
 *    report is not complete (`dayReportIsComplete`: `ready` or `refused`)
 *    sends nothing, writes no marker and counts the user in `notReady`, so
 *    the next slot retries. An evening whose report never completes has no
 *    summary that day — a tap must never open a "Writing…" report. The one
 *    exception is `not_configured` (no `ANTHROPIC_API_KEY`): no report is
 *    ever coming, so the push goes out (`dayReportPushMayGo`).
 *  - the never-twice marker (`daily_summary_last_sent_day`) is written ONLY
 *    when at least one token reported `delivered` — the check-price-alerts
 *    doctrine. A later slot retries an undelivered push; once the ladder is
 *    spent, an evening where APNs errors for every token has no summary.
 *    Deliberate, not a bug: a marker written for an undelivered push would
 *    silently swallow the day.
 *  - the trading-day gate leans on the persisted market calendar. A holiday
 *    the store never captured makes `dailySummaryDayToSend` treat the weekday
 *    as a session; `composeDailySummaryAlert`'s null-on-no-day-data path is
 *    the backstop, and the residual risk (a stale previous-session figure) is
 *    accepted by the plan.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  const refused = cronGate(request, env().CRON_SECRET);
  if (refused) return refused;

  try {
    const calendar = await readStoredCalendar();
    const dayISO = dailySummaryDayToSend(Date.now(), calendar.overrides);
    if (dayISO === null) {
      return Response.json({ ok: true, skipped: 'not-a-trading-day' }, { headers: NO_STORE });
    }

    let sent = 0;
    let reports = 0;
    let notReady = 0;
    const invalidTokens = new Set<string>();

    // Best-effort per user, like check-price-alerts: one user's failure never
    // blocks the next user's summary. Every account is walked — the close
    // report is written whether or not the push switch is on; the switch only
    // decides the push below.
    for (const user of await listDayReportUsers()) {
      try {
        const narrative = await ensureDayReportNarrative(user.userId, dayISO, null, 'close').catch(
          (error) => {
            const message = error instanceof Error ? error.message : 'narrative failed';
            console.error(`[cron/daily-summary] narrative ${user.userId}: ${message}`);
            return null;
          },
        );
        const complete = dayReportIsComplete(narrative);
        if (complete) reports++;

        if (!user.dailySummary || user.dailySummaryLastSentDay === dayISO) continue;
        // The push deep-links to the close report: hold it — no send, no
        // marker — until that report is complete, so a later slot retries.
        // `not_configured` (no writer key) goes out: no report is coming.
        if (!dayReportPushMayGo(narrative)) {
          notReady++;
          console.warn(
            `[cron/daily-summary] held ${user.userId}: report ${narrative?.status ?? 'failed'}`,
          );
          continue;
        }

        const tokenRows = await db
          .select({ token: pushTokens.token })
          .from(pushTokens)
          .where(eq(pushTokens.userId, user.userId));
        const tokens = tokenRows.map((r) => r.token);
        if (tokens.length === 0) continue;

        // Fresh vendor quotes + NBP FX by construction. Options positions are
        // never loaded — `loadHoldingsInputs` walks the `transactions` table
        // only, so the options island stays excluded, as in portfolio totals.
        const loaded = await loadHoldingsInputs(user.userId);
        // ALL portfolios merged — exactly `portfolio-rollup.ts`'s composition,
        // which is the all-holdings header pair the notification quotes.
        const positions = displayablePositions(
          computePositions(loaded.rows, loaded.quotes, loaded.inputs.fxRates),
        );
        const summary = computePortfolioSummary(positions, loaded.quotes, loaded.inputs.fxRates);

        const alert = composeDailySummaryAlert(summary, dayISO);
        if (alert === null) continue;

        const outcomes = await sendPushAlert(tokens, alert);
        for (const [token, outcome] of outcomes) {
          if (outcome === 'invalid-token') invalidTokens.add(token);
        }
        if ([...outcomes.values()].includes('delivered')) {
          sent++;
          await markDailySummarySent(user.userId, dayISO);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'summary failed';
        console.error(`[cron/daily-summary] user ${user.userId}: ${message}`);
      }
    }

    if (invalidTokens.size > 0) await pruneInvalidTokens([...invalidTokens]);

    return Response.json({ ok: true, day: dayISO, reports, sent, notReady }, { headers: NO_STORE });
  } catch (error) {
    console.error('[cron/daily-summary]', error);
    return Response.json({ error: 'Summary failed.' }, { status: 502, headers: NO_STORE });
  }
}
