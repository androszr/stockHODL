import type { DayReportResponse } from '@/lib/api/contracts/day-report';

export type DayReportNarrativeResponse = DayReportResponse['narrative'];

/**
 * The headline figure a report showed when it was composed, in the shape the
 * narrative store persists beside the written text (`day_reports.figure_day`,
 * `day_change_pln`, `day_change_pct`, `figure_partial`). Decimal STRINGS from
 * `Decimal.toString()` — never a number — so the history list formats exactly
 * what the report page formatted, through the same `dec()` path.
 */
export interface StoredDayFigure {
  /** The session the figure describes: the report day for `close`, the previous session for `morning`. */
  figureDay: string;
  dayChangePLN: string | null;
  dayChangePct: string | null;
  partial: boolean;
}
