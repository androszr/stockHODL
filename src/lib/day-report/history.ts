import 'server-only';

import { and, asc, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';

import type { DayReportHistoryResponse } from '@/lib/api/contracts/day-report';
import { db, dayReports } from '@/lib/db';
import { nyDateISOAt } from '@/lib/market-data/market-clock';

import {
  composeDayReportHistory,
  HISTORY_PAGE_SIZE,
  parseHistoryCursor,
  type DayReportHistoryRow,
  type HistoryCursor,
} from './history-compose';

/**
 * The Dashboard's day-report history: one indexed PK-prefix query on
 * `day_reports`, the caller's own rows only, the all-portfolios scope only
 * (the Dashboard shows every portfolio), and only rows that ARE reports —
 * `pending` is a 15-minute reservation, not a report. Newest first, close
 * before morning within a day (`'close' < 'morning'` lexically). Deliberately
 * not memoised: it is one cheap query, and the report memo is per report.
 */
export interface HistoryDependencies {
  select: (userId: string, cursor: HistoryCursor | null, limit: number) => Promise<DayReportHistoryRow[]>;
  nowMs: () => number;
}

export async function listDayReportHistory(
  userId: string,
  cursor?: string,
  dependencies: HistoryDependencies = productionDependencies,
): Promise<DayReportHistoryResponse> {
  const parsed = parseHistoryCursor(cursor);
  const rows = await dependencies.select(userId, parsed, HISTORY_PAGE_SIZE + 1);
  return composeDayReportHistory(rows, {
    pageSize: HISTORY_PAGE_SIZE,
    todayNY: nyDateISOAt(dependencies.nowMs()),
  });
}

async function selectHistoryRows(
  userId: string,
  cursor: HistoryCursor | null,
  limit: number,
): Promise<DayReportHistoryRow[]> {
  // Keyset: strictly OLDER than the cursor row in (day desc, kind asc) order.
  const after =
    cursor === null
      ? undefined
      : or(
          lt(dayReports.day, cursor.day),
          and(eq(dayReports.day, cursor.day), gt(dayReports.kind, cursor.kind)),
        );
  return db
    .select({
      day: dayReports.day,
      kind: dayReports.kind,
      status: dayReports.status,
      figureDay: dayReports.figureDay,
      dayChangePln: dayReports.dayChangePln,
      dayChangePct: dayReports.dayChangePct,
      figurePartial: dayReports.figurePartial,
    })
    .from(dayReports)
    .where(
      and(
        eq(dayReports.userId, userId),
        eq(dayReports.scopeKey, 'all'),
        inArray(dayReports.status, ['ready', 'refused']),
        after,
      ),
    )
    .orderBy(desc(dayReports.day), asc(dayReports.kind))
    .limit(limit);
}

const productionDependencies: HistoryDependencies = {
  select: selectHistoryRows,
  nowMs: () => Date.now(),
};
