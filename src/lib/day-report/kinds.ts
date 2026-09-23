export const DAY_REPORT_KINDS = ['morning', 'close'] as const;

export type DayReportKind = (typeof DAY_REPORT_KINDS)[number];

export function scopeKeyFor(portfolioId: string | null | undefined): string {
  return portfolioId ?? 'all';
}
