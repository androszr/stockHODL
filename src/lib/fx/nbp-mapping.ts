import { z } from 'zod';

import { dec } from '@/lib/money';

/**
 * Pure mapping between NBP's Table A payloads and the FX lookup, plus the
 * calendar math for the D-1 rule (art. 11a PIT/CIT: the mid rate of the last
 * business day STRICTLY BEFORE the trade date). Deliberately isomorphic with
 * no server marker (same rationale as `massive-mapping.ts`: reads neither env
 * nor the database) so the unit tests can import it directly. The fetch,
 * caching and persistence live in `nbp.ts`.
 *
 * THE MONEY BOUNDARY for FX lives here and nowhere else. NBP serializes `mid`
 * as a JSON number; after `JSON.parse` it is already a `number` — there is
 * nothing left to string-parse. It goes straight into `dec(raw)` (decimal.js
 * converts a JS number via its shortest round-trip decimal representation —
 * exactly the digits NBP serialized) and is emitted as a decimal STRING. No
 * arithmetic ever happens on the raw number.
 *
 * All date math is UTC-calendar string math. Never `new Date('YYYY-MM-DD')`
 * interpreted in local time — that shifts the day west of UTC (same rationale
 * as `isValidCalendarDate` in `validation.ts`). Date parts are calendar
 * integers, not money: `parseInt` on them is correct and stays confined to
 * these helpers.
 */

/** First date the NBP API has data for. */
export const NBP_FIRST_DATE = '2002-01-02';

/** The calendar-day shift moved to `@/lib/dates` (2026-08-16, trim-bundle
 *  plan) so `charts/ranges.ts` stops chaining zod into the client bundle;
 *  re-exported here so every server-side importer compiles unchanged. */
export { addDaysIso } from '@/lib/dates';

import { addDaysIso } from '@/lib/dates';

/** 'YYYY-MM-DD' → UTC ms. Calendar integers only — never used for money. */
function isoToUtcMs(iso: string): number {
  const [y, m, d] = iso.split('-');
  return Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
}

/**
 * The last Mon–Fri calendar day strictly before `iso`. Skips Saturdays and
 * Sundays only — it knows nothing of Polish holidays. That is exactly the
 * strength the cache lookup needs: if this day has a stored rate, no later
 * rate can exist before the trade date (NBP never publishes on weekends); if
 * it was a holiday, the row can never exist and the miss falls through to NBP,
 * which resolves the true prior business day.
 */
export function lastWeekdayBefore(iso: string): string {
  let cursor = addDaysIso(iso, -1);
  while (isWeekend(cursor)) cursor = addDaysIso(cursor, -1);
  return cursor;
}

function isWeekend(iso: string): boolean {
  const dow = new Date(isoToUtcMs(iso)).getUTCDay(); // 0 = Sunday, 6 = Saturday
  return dow === 0 || dow === 6;
}

/**
 * The NBP range-query window for a trade date: ends at D−1 (strictly before
 * the trade date), starts 14 days back — wide enough for the worst Polish
 * holiday clusters (Christmas, Easter, May). NBP returns only published days,
 * ascending, so the LAST element of the response is the D-1 rate.
 */
export function d1Window(tradeDate: string): { from: string; to: string } {
  return { from: addDaysIso(tradeDate, -14), to: addDaysIso(tradeDate, -1) };
}

/**
 * Whether the newest row of a D-1 window response may still be superseded
 * TODAY — i.e. the window ends on today's Warsaw calendar day, that day is a
 * potential publication day (Mon–Fri; NBP never publishes on weekends), and
 * the response does not contain it yet. NBP publishes ~12:15 CET, so before
 * publication a window ending today returns rates only through yesterday: a
 * correct-LOOKING but wrong D-1 rate that must be reported `not_published`,
 * not `ok`. When today is itself a weekday holiday this is merely conservative
 * (no rate for `to` will ever appear) — the right direction to err for money.
 * Takes `todayWarsaw` injected so it is hermetic under test.
 */
export function isPendingPublication(input: {
  to: string;
  todayWarsaw: string;
  lastEffectiveDate: string;
}): boolean {
  return (
    input.to === input.todayWarsaw &&
    !isWeekend(input.to) &&
    input.lastEffectiveDate !== input.to
  );
}

/* ------------------------------------------------------------------ *
 * Zod schema — loose on purpose, like the Massive schemas. Unknown
 * extras must never fail the parse; the mapper drops unusable entries
 * instead of the schema rejecting the whole body.
 * ------------------------------------------------------------------ */

export const nbpRatesResponseSchema = z.looseObject({
  rates: z
    .array(
      z.looseObject({
        effectiveDate: z.string().optional(),
        /** JSON number — crosses into Decimal in `mapNbpRates`, nowhere else. */
        mid: z.number().optional(),
      }),
    )
    .optional(),
});

export type NbpRatesResponse = z.infer<typeof nbpRatesResponseSchema>;

export interface NbpRate {
  /** NBP's own publication date — the `fx_rates` row key, never the trade date. */
  effectiveDate: string;
  /** Decimal string, shortest round-trip digits. */
  rate: string;
}

/**
 * Maps a parsed NBP response to `{ effectiveDate, rate }` rows. Entries
 * missing either field are dropped without failing the rest; order is
 * preserved (NBP returns ascending by `effectiveDate`, so the last element is
 * the D-1 rate). The one sanctioned number→Decimal crossing: shortest
 * round-trip digits out (same discipline as `decString` in
 * `massive-mapping.ts`).
 */
export function mapNbpRates(parsed: NbpRatesResponse): NbpRate[] {
  const rows: NbpRate[] = [];
  for (const entry of parsed.rates ?? []) {
    if (entry.effectiveDate === undefined || entry.mid === undefined) continue;
    rows.push({ effectiveDate: entry.effectiveDate, rate: dec(entry.mid).toString() });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Range-series helpers (M5 charts). NBP's range endpoint answers at
 * most 367 days per request, and a value series needs a rate for EVERY
 * calendar day — the same D-1 semantics as single lookups, applied as
 * carry-forward over non-publication days.
 * ------------------------------------------------------------------ */

/** NBP's range endpoint rejects windows longer than 367 days; stay under. */
export const NBP_MAX_RANGE_DAYS = 360;

/**
 * Splits an inclusive date range into consecutive chunks of at most
 * `maxDays` calendar days each — the unit one NBP range request can answer.
 * An inverted range yields no chunks.
 */
export function splitDateRange(
  from: string,
  to: string,
  maxDays: number = NBP_MAX_RANGE_DAYS,
): { from: string; to: string }[] {
  const chunks: { from: string; to: string }[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDaysIso(cursor, maxDays - 1);
    chunks.push({ from: cursor, to: end < to ? end : to });
    cursor = addDaysIso(end, 1);
  }
  return chunks;
}

/**
 * Densifies published rates into a per-calendar-day map over [from..to]:
 * every day carries the newest rate published ON OR BEFORE it — weekend and
 * holiday days inherit the prior business day's rate, exactly the D-1 rule's
 * semantics applied to a series. Days before the first available published
 * rate are simply absent (never a fake seed). `rows` may start before `from`
 * (a lookback seed) and need not be sorted.
 */
export function carryForwardRates(
  rows: readonly NbpRate[],
  from: string,
  to: string,
): Map<string, string> {
  const sorted = [...rows].sort((a, b) =>
    a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0,
  );

  const dense = new Map<string, string>();
  let index = 0;
  let last: string | null = null;

  // Seed with everything published before the window starts.
  while (index < sorted.length && sorted[index].effectiveDate < from) {
    last = sorted[index].rate;
    index++;
  }

  for (let day = from; day <= to; day = addDaysIso(day, 1)) {
    while (index < sorted.length && sorted[index].effectiveDate <= day) {
      last = sorted[index].rate;
      index++;
    }
    if (last !== null) dense.set(day, last);
  }

  return dense;
}
