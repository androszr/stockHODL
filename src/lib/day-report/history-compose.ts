import type { DayReportHistoryItem, DayReportHistoryResponse } from '@/lib/api/contracts/day-report';
import { signedMoney } from '@/lib/holdings/live-payload';
import { dec, directionOf, fmtPct } from '@/lib/money';

import type { DayReportKind } from './kinds';

/**
 * The pure half of the Dashboard's day-report history (`history.ts` is the
 * `server-only` half that runs the one query). Isomorphic and unit-tested: it
 * takes rows already selected newest-first and turns them into the wire
 * shape, formatting the PERSISTED headline through the same `dec()` →
 * `signedMoney` / `fmtPct` / `directionOf` path the report page used when it
 * was written. Nothing here computes a figure; a row with no stored figure
 * becomes a null `dayChange`, never `"0,00"`.
 */

export const HISTORY_PAGE_SIZE = 30;

/** The columns `history.ts` selects from `day_reports`. `numeric` arrives as a string. */
export interface DayReportHistoryRow {
  day: string;
  kind: string;
  status: string;
  figureDay: string | null;
  dayChangePln: string | null;
  dayChangePct: string | null;
  figurePartial: boolean;
}

export interface HistoryCursor {
  day: string;
  kind: DayReportKind;
}

const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}):(morning|close)$/;

/** `YYYY-MM-DD:kind` → its parts, or null for anything else. */
export function parseHistoryCursor(cursor: string | undefined | null): HistoryCursor | null {
  if (!cursor) return null;
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) return null;
  return { day: match[1] as string, kind: match[2] as DayReportKind };
}

export function formatHistoryCursor(day: string, kind: string): string {
  return `${day}:${kind}`;
}

/**
 * Up to `pageSize + 1` rows in (newest-first) → `pageSize` items and a cursor
 * naming the last emitted row iff the extra row was present. The cursor is a
 * keyset, not an offset: a report written between two pages cannot shift the
 * window and duplicate a row.
 */
export function composeDayReportHistory(
  rows: readonly DayReportHistoryRow[],
  options: { pageSize?: number; todayNY: string },
): DayReportHistoryResponse {
  const pageSize = options.pageSize ?? HISTORY_PAGE_SIZE;
  const page = rows.slice(0, pageSize);
  const hasMore = rows.length > pageSize;
  const items = page.map((row) => composeItem(row, options.todayNY));
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? formatHistoryCursor(last.day, last.kind) : null,
  };
}

function composeItem(row: DayReportHistoryRow, todayNY: string): DayReportHistoryItem {
  const pln = row.dayChangePln === null ? null : dec(row.dayChangePln);
  const pct = row.dayChangePct === null ? null : dec(row.dayChangePct);
  return {
    day: row.day,
    kind: row.kind === 'morning' ? 'morning' : 'close',
    dayLabel: shortDayLabel(row.day, todayNY),
    figureDay: row.figureDay,
    figureDayLabel: row.figureDay === null ? null : shortDayLabel(row.figureDay, todayNY),
    dayChange: pln === null ? null : { text: signedMoney(pln, 'PLN'), direction: directionOf(pln) },
    dayChangePct: pct === null ? null : fmtPct(pct),
    partial: row.figurePartial,
    narrativeStatus: row.status === 'refused' ? 'refused' : 'ready',
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * "Fri 19 Sep", English, hand-rolled rather than `Intl` so the text is the
 * same on every Node/ICU (en-GB prints "Sept" on newer CLDRs). The year is
 * appended only when it differs from `todayNY`'s, so a list of this year's
 * reports stays short and last year's rows say which year they are.
 */
export function shortDayLabel(dayISO: string, todayNY: string): string {
  // A calendar date, not money: noon UTC keeps the weekday stable on any host.
  const date = new Date(`${dayISO}T12:00:00Z`);
  const weekday = WEEKDAYS[date.getUTCDay()];
  const monthName = MONTHS[date.getUTCMonth()] ?? '';
  const base = `${weekday} ${date.getUTCDate()} ${monthName}`;
  return dayISO.slice(0, 4) === todayNY.slice(0, 4) ? base : `${base} ${date.getUTCFullYear()}`;
}
