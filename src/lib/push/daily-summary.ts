import { signedMoney } from '@/lib/holdings/live-payload';
import type { PortfolioSummary } from '@/lib/holdings/summary';
import {
  lastCompletedSessionDateISO,
  nyDateISOAt,
  regularSessionFor,
  type CalendarOverride,
} from '@/lib/market-data/market-clock';
import { fmtPct } from '@/lib/money';
import type { DayReportKind } from '@/lib/day-report/kinds';

import type { PushAlert } from './apns';

/**
 * The pure half of the daily portfolio-summary push
 * (plans/2026-09-05-daily-portfolio-summary-push.md) — isomorphic like
 * `summary.ts`: no db, no env, no fetch. The cron route
 * (`/api/cron/daily-summary`) supplies the impure inputs and sends what this
 * file composes.
 *
 * All arithmetic stays in the Decimals the summary already carries — this
 * file only formats; money is never parsed back out of a string
 * (non-negotiable #1).
 */

/**
 * The NY-calendar day a summary should be sent for at `nowMs`, or null when
 * today is not one. One comparison covers everything: today has a summary iff
 * the most recent COMPLETED regular session IS today — a holiday's last
 * completed session is an earlier date, a weekend's likewise (belt beside the
 * cron schedule's `1-5`), and an early-close day is still today once its
 * (early) close has passed.
 *
 * The day key is `nyDateISOAt`, never a UTC date: the schedule happens to run
 * at an hour where the two agree, but nothing here may rely on the schedule
 * staying put.
 */
export function dailySummaryDayToSend(
  nowMs: number,
  overrides: readonly CalendarOverride[],
): string | null {
  const today = nyDateISOAt(nowMs);
  return lastCompletedSessionDateISO(nowMs, overrides) === today ? today : null;
}

export function morningBriefDayToSend(
  nowMs: number,
  overrides: readonly CalendarOverride[],
): string | null {
  const today = nyDateISOAt(nowMs);
  const session = regularSessionFor(today, overrides);
  return session !== null && nowMs < session.openMs ? today : null;
}

export function dayReportUrlScheme(dayISO: string, kind: DayReportKind): string {
  // The two concrete forms are `?kind=close` and `?kind=morning`.
  return `stockhodl://day-report/${dayISO}?kind=${kind}`;
}

/**
 * One evening's alert, or null when there is nothing honest to say
 * (`dayChangePLN === null` — no priced positions, or no priced position had
 * day data). Honesty paths, per the plan:
 *
 *   - `partialDayChange` → the figure is a floor and the body says "At least";
 *   - `excludedSymbols` → a second line NAMES the tickers left out (never a
 *     count — the exclusion semantics of `summary.ts` carried to the wire).
 */
export function composeDailySummaryAlert(
  summary: PortfolioSummary,
  dayISO: string,
): PushAlert | null {
  if (summary.dayChangePLN === null) return null;

  // A zero prior-day base leaves `dayChangePct` null while the PLN figure is
  // real; the Holdings header drops the parenthetical then, and so does this.
  const money = signedMoney(summary.dayChangePLN, 'PLN');
  const figure =
    summary.dayChangePct === null ? money : `${money} (${fmtPct(summary.dayChangePct)})`;
  const headline = summary.partialDayChange ? `At least ${figure}` : figure;
  const body =
    summary.excludedSymbols.length > 0
      ? `${headline}\nWithout: ${summary.excludedSymbols.join(', ')}`
      : headline;

  return {
    title: 'Portfolio today',
    body,
    urlScheme: dayReportUrlScheme(dayISO, 'close'),
  };
}
