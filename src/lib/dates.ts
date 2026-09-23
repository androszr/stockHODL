/**
 * Pure calendar-day math, shared by both sides of the wire. Moved verbatim
 * from `fx/nbp-mapping.ts` (2026-08-16, trim-bundle plan) so the chart range
 * math in `charts/ranges.ts` — which every client chart component imports —
 * no longer drags the schema-validation-backed NBP mapping module into the
 * client bundle.
 *
 * ZERO imports of any kind, isomorphic by construction. All date math is
 * UTC-calendar string math. Never `new Date('YYYY-MM-DD')` interpreted in
 * local time — that shifts the day west of UTC (same rationale as
 * `isValidCalendarDate` in `validation.ts`). Date parts are calendar
 * integers, not money: `parseInt` on them is the documented sanctioned use —
 * no money ever crosses this file.
 */

const MS_PER_DAY = 86_400_000;

/** 'YYYY-MM-DD' → UTC ms. Calendar integers only — never used for money. */
function isoToUtcMs(iso: string): number {
  const [y, m, d] = iso.split('-');
  return Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
}

/** UTC ms → 'YYYY-MM-DD' via UTC getters (never local time). */
function utcMsToIso(ms: number): string {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Shift an ISO date by whole calendar days. UTC has no DST, so ms math is exact. */
export function addDaysIso(iso: string, delta: number): string {
  return utcMsToIso(isoToUtcMs(iso) + delta * MS_PER_DAY);
}
