import type { DayReportNarrativeResponse } from './view-types';

/**
 * Whether a day report is COMPLETE — a finished `day_reports` row — so the
 * push that deep-links to it may go out
 * (plans/2026-09-23-report-push-waits-for-report.md). Isomorphic: no db, no
 * env.
 *
 * "Complete" is `ready` (the writer's prose is stored) or `refused` (the
 * writer declined, which is terminal for the day). That is the same pair
 * `history.ts` selects in SQL (`inArray(dayReports.status, ['ready',
 * 'refused'])`) — keep the two in step. `pending` (a live reservation, or no
 * row at all), `unavailable` and `not_configured` are not reports, and a
 * `null` narrative (the write threw) is not one either.
 */
export function dayReportIsComplete(narrative: DayReportNarrativeResponse | null): boolean {
  return narrative?.status === 'ready' || narrative?.status === 'refused';
}

/**
 * Whether a cron may send the push that deep-links to this report: once the
 * report is complete, OR when no report is ever coming — `not_configured`
 * means this deployment has no `ANTHROPIC_API_KEY` (an optional key), so
 * holding would silence the push forever and log a false "held" every slot.
 * `pending`, `unavailable` and `null` (a failed write) still hold: those can
 * still finish on a later slot. Deliberately a sibling rather than a change
 * to `dayReportIsComplete`, which keeps meaning "a finished row" — the
 * routes' `reports` count and `history.ts` rely on that.
 */
export function dayReportPushMayGo(narrative: DayReportNarrativeResponse | null): boolean {
  return dayReportIsComplete(narrative) || narrative?.status === 'not_configured';
}
