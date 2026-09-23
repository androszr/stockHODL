import { addMonthsIso } from '@/lib/charts/ranges';

/**
 * Calendar-date helpers for the options modules — effectively a LEAF as far as
 * the options tree is concerned: its only import is `@/lib/charts/ranges`,
 * which imports nothing from `@/lib/options`, so every options module can
 * still depend on it without creating a cycle. (It imported literally nothing
 * until 2026-08-20, when `optionBackfillFrom` below reused `addMonthsIso`
 * rather than growing a fourth copy of calendar-month subtraction.)
 *
 * It exists because the same six lines had drifted into three copies
 * (`options-payload.ts` exported one, `contract-match.ts` and `fresh-print.ts`
 * each kept a private twin) and the exported one had closed a genuine import
 * cycle: `option-mark.ts` → `options-payload.ts` → `option-mark.ts`. That
 * cycle is harmless only for as long as both files expose nothing but hoisted
 * function declarations — the first module-level `const` in either file would
 * make it bite, at import time, in a way that is thoroughly unpleasant to
 * debug. Found during the 2026-08-15 review; a shared leaf removes both
 * problems at once.
 */

const MS_PER_DAY = 86_400_000;

/**
 * 'YYYY-MM-DD' → epoch ms at UTC NOON. Noon, not midnight, so that adding or
 * differencing whole days can never be pushed across a date boundary by a DST
 * shift — the app's standard calendar idiom.
 *
 * Date components are COUNTS, not money: `parseInt` is sanctioned here and
 * nowhere near a price.
 */
export function utcNoonMs(dateISO: string): number {
  const [y, m, d] = dateISO.split('-');
  return Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), 12);
}

/** Whole calendar days between two 'YYYY-MM-DD' dates, unsigned. */
export function calendarDaysBetween(aISO: string, bISO: string): number {
  return Math.abs(Math.round((utcNoonMs(aISO) - utcNoonMs(bISO)) / MS_PER_DAY));
}

/**
 * Shift a 'YYYY-MM-DD' date by whole calendar days (negative = backwards),
 * returning 'YYYY-MM-DD'. Built on the UTC-NOON idiom for the same reason
 * `utcNoonMs` is: a midnight-based helper drifts a day across a DST boundary
 * and would silently narrow any window computed from it.
 *
 * Days are COUNTS, not money — plain integer arithmetic is correct here.
 */
export function addCalendarDaysISO(dateISO: string, days: number): string {
  const shifted = new Date(utcNoonMs(dateISO) + days * MS_PER_DAY);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d
    .toString()
    .padStart(2, '0')}`;
}

/**
 * How far back the one-off option-close BACKFILL asks the vendor (2026-08-20).
 * Three months: measured on this tier, `/v2/aggs` serves a full ~63-session
 * daily window for a contract in one request, and three months is the depth
 * the `1M`/`6M` chart ranges bracket.
 */
export const OPTION_HISTORY_LOOKBACK_MONTHS = 3;

/**
 * The backfill window's left edge for ONE contract — pure, no clock read.
 *
 * `today − 3 months`, RAISED to the lot's own trade date when the lot was
 * opened later: `composeOptionsSeries` skips a lot whose `tradeDate > date`,
 * so a bar from before the lot existed can never become a point and fetching
 * it is pure waste. End-of-month clamping is inherited from `addMonthsIso`
 * (Mar 31 − 3M → Dec 31 is unaffected; May 31 − 3M → Feb 28).
 *
 * Dates are calendar strings, compared lexicographically — never money.
 */
export function optionBackfillFrom(todayISO: string, tradeDateISO: string): string {
  const floor = addMonthsIso(todayISO, -OPTION_HISTORY_LOOKBACK_MONTHS);
  return tradeDateISO > floor ? tradeDateISO : floor;
}
