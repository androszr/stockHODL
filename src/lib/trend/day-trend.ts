import { dec, directionOf, fmtPct, pctChange, type Direction, type Money } from '@/lib/money';

import { EQUITY_TREND_SCALE, type TrendScale } from './trend-scale';

/**
 * Daily valuations → the five-session trend strip the iOS tile draws along its
 * bottom edge (plans `2026-08-22-ios-five-day-trend-lights`, extended to
 * options by `2026-08-22-ios-option-tile-trend-lights`).
 *
 * PURE, and deliberately not `server-only`: it imports no database and no
 * provider, so the web tile can reuse it verbatim when it grows the same
 * strip, and the whole threshold table is unit-testable without a fixture.
 *
 * The design decision this module encodes: **colour carries direction, height
 * carries magnitude**. That is why `level` is a small integer and there is no
 * shade, opacity or intensity anywhere in the contract — twenty tiles times
 * five colour-graded dots is a wall in which nothing stands out, and the tile
 * already spends colour on two other figures. A renderer that reaches for a
 * paler green is undoing the design, not refining it.
 *
 * **The strip is placed on SESSIONS, not on stored rows** (2026-08-22). It used
 * to walk adjacent rows and call every pair one session, which is true only
 * while the recorder never misses an evening. Options break that in principle
 * — both option tables document that a date with no row is an honest hole,
 * never interpolated — and equities break it in practice the first time a
 * nightly fetch fails, silently reporting a two-session move as one day's. So
 * the caller supplies the calendar and a session with no figure stays a hole
 * here rather than being closed up.
 */

export interface TrendDay {
  /** The session's calendar date, 'YYYY-MM-DD' — carried, not yet rendered. */
  date: string;
  direction: Direction;
  /** 0 = flat, 3 = full height. DISCRETE — never a ratio, never a shade. */
  level: 0 | 1 | 2 | 3;
  /** Pre-formatted, for the accessibility phrase only. Never re-parsed. */
  pct: string;
}

/**
 * One slot of the strip: a graded session, or `null` for one the strip has no
 * honest figure for.
 *
 * A hole is NOT a flat day and the two must never collapse into each other. A
 * flat day is a fact about the market — it opened, it traded, it went nowhere —
 * and the strip states it with a neutral dash. A hole is the absence of a fact.
 * Rendering the second as the first is the tile asserting that a contract sat
 * still on a day it simply never traded.
 */
export type TrendSlot = TrendDay | null;

/**
 * Which kind of number a valuation is. Equity closes are all `'close'`; an
 * option's evening is a model `'mark'` where one could be produced and a real
 * traded `'close'` otherwise (`mergeOptionValuations`).
 */
export type ValuationSource = 'close' | 'mark';

/** One stored valuation for one session. */
export interface ClosePoint {
  asOf: string;
  close: string;
  /** Absent means `'close'` — every equity caller predates this field. */
  source?: ValuationSource;
}

/** How many marks the strip draws. */
export const TREND_DAYS = 5;

/** Sessions the grader needs to fill a full strip: N changes need N+1 points. */
export const TREND_SESSIONS_NEEDED = TREND_DAYS + 1;

/**
 * A day that moved less than the scale's flat band has NO SIDE — it reports
 * `neutral` whatever the sign, because a 0.03% loss drawn in red is the tile
 * asserting a fact about the week that nobody would defend out loud.
 */
function gradeOf(
  changePct: Money,
  scale: TrendScale,
): { direction: Direction; level: TrendDay['level'] } {
  const magnitude = changePct.abs();
  if (magnitude.lessThan(scale.flatMaxPct)) return { direction: 'neutral', level: 0 };
  const direction = directionOf(changePct);
  if (magnitude.lessThan(scale.level1MaxPct)) return { direction, level: 1 };
  if (magnitude.lessThan(scale.level2MaxPct)) return { direction, level: 2 };
  return { direction, level: 3 };
}

const sourceOf = (point: ClosePoint): ValuationSource => point.source ?? 'close';

/**
 * The strip, OLDEST FIRST — so the array index is the column index and the
 * view does no reversing.
 *
 * `sessions` is the calendar, oldest first, and the result has one slot per
 * session AFTER the first: the oldest session is the basis the second measures
 * from, never a slot of its own. Pass {@link TREND_SESSIONS_NEEDED} sessions to
 * fill a strip of {@link TREND_DAYS}.
 *
 * A slot is a hole when any of these is true, and each is a different fact the
 * strip refuses to paper over:
 *
 * - **Either end is missing.** Nothing was recorded for that session, so there
 *   is no move to describe. Note this holes TWO slots around a single gap —
 *   the session itself and the one after it, which would otherwise measure
 *   across the gap. That is the whole point.
 * - **The two ends are different KINDS of number.** A model mark against a real
 *   traded close is a change of measuring instrument as much as a change of
 *   price, and the difference between them is not a return. `mergeOptionValuations`
 *   is right to mix the two in a LEVEL series — each date gets its best
 *   available valuation — but a CHANGE is a subtraction, and subtracting an
 *   estimate from a print produces a number with no name. Equity points are all
 *   `'close'`, so this rule is inert there by construction.
 * - **The basis is zero.** `pctChange` refuses the division. A zero close is a
 *   data fault, and inventing a direction for it would put a green bar on a
 *   tile to describe a bug.
 *
 * `float` never appears: the valuations are decimal strings from
 * `numeric(20,8)` and every comparison here is a Decimal comparison
 * (non-negotiable #1).
 */
export function toTrendDays(
  sessions: readonly string[],
  points: readonly ClosePoint[],
  scale: TrendScale = EQUITY_TREND_SCALE,
): TrendSlot[] {
  const byDate = new Map<string, ClosePoint>();
  for (const point of points) byDate.set(point.asOf, point);

  const slots: TrendSlot[] = [];
  for (let i = 1; i < sessions.length; i += 1) {
    slots.push(gradeSession(byDate.get(sessions[i - 1]), byDate.get(sessions[i]), scale));
  }
  return slots;
}

function gradeSession(
  previous: ClosePoint | undefined,
  current: ClosePoint | undefined,
  scale: TrendScale,
): TrendSlot {
  if (!previous || !current) return null;
  if (sourceOf(previous) !== sourceOf(current)) return null;

  const change = pctChange(dec(previous.close), dec(current.close));
  if (change === null) return null;

  const { direction, level } = gradeOf(change, scale);
  return { date: current.asOf, direction, level, pct: fmtPct(change) };
}

/** True when the strip has nothing to say at all — every slot a hole. */
export function isEmptyStrip(slots: readonly TrendSlot[]): boolean {
  return slots.every((slot) => slot === null);
}
