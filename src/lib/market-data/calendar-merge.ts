import type { CalendarOverride } from './market-clock';

/**
 * Pure merge of the two calendar sources — the durable stored rows (the only
 * record of PAST closures: the vendor's upcoming-calendar feed is future-only
 * and drops a date the moment it passes) and the fresh vendor list. The
 * `nbp-mapping.ts` split: isomorphic, no DB, no fetch, so the real failure
 * shape — a past holiday absent from the fresh fetch but present in storage —
 * is unit-testable end to end through `extendedAttribution`.
 *
 * Rules:
 * - union by date;
 * - the FETCHED row wins a shared date (a published correction — say an
 *   early-close upgraded to a full closure — must propagate);
 * - stored rows are RETAINED after their date passes (the entire point);
 * - output sorted by date, like `mapUpcomingToOverrides`, so downstream
 *   consumers see one consistent shape regardless of source.
 */
export function mergeCalendarSources(
  stored: readonly CalendarOverride[],
  fetched: readonly CalendarOverride[],
): CalendarOverride[] {
  const byDate = new Map<string, CalendarOverride>();
  for (const row of stored) byDate.set(row.date, row);
  for (const row of fetched) byDate.set(row.date, row);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
