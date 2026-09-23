import { addDaysIso } from '@/lib/fx/nbp-mapping';

/**
 * Pure coverage-gap arithmetic for the daily price-history cache. Deliberately
 * isomorphic — no `server-only`, no DB — so the hole-filling logic is unit
 * testable without mocking Drizzle (the same split as `nbp-mapping.ts` vs
 * `nbp.ts`).
 *
 * Coverage is ONE inclusive interval per instrument (see the schema note on
 * `price_history_coverage`): every chart window ends "today", so a new want
 * only ever extends coverage left (a longer range) or right (a new day) —
 * never a disjoint island. `missingRanges` still handles a disjoint want
 * defensively by bridging the gap, so the union of covered + returned gaps is
 * always a single contiguous interval and the one-interval invariant survives
 * any caller.
 *
 * Dates are plain 'YYYY-MM-DD' strings, compared lexicographically — calendar
 * data, never money.
 */

export interface DateRange {
  /** Inclusive 'YYYY-MM-DD'. */
  from: string;
  /** Inclusive 'YYYY-MM-DD'. */
  to: string;
}

/**
 * The sub-ranges of `wanted` the provider has not been asked about yet: 0
 * (fully covered), 1 (extend one side) or 2 (extend both sides) ranges. With
 * no coverage at all, the whole want comes back as one gap.
 */
export function missingRanges(wanted: DateRange, covered: DateRange | null): DateRange[] {
  if (wanted.from > wanted.to) return [];
  if (covered === null) return [{ ...wanted }];

  const gaps: DateRange[] = [];

  // Left of coverage — up to the day before covered_from. A want disjoint to
  // the left still bridges up to the coverage edge, keeping the union interval
  // contiguous.
  if (wanted.from < covered.from) {
    gaps.push({ from: wanted.from, to: addDaysIso(covered.from, -1) });
  }

  // Right of coverage — from the day after covered_to. Same bridging rule.
  if (wanted.to > covered.to) {
    gaps.push({ from: addDaysIso(covered.to, 1), to: wanted.to });
  }

  return gaps;
}

/** The single contiguous interval after a gap was fully fetched and stored. */
export function extendCoverage(covered: DateRange | null, fetched: DateRange): DateRange {
  if (covered === null) return { ...fetched };
  return {
    from: fetched.from < covered.from ? fetched.from : covered.from,
    to: fetched.to > covered.to ? fetched.to : covered.to,
  };
}
