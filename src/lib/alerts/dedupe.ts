import type { Money } from '@/lib/money';

/**
 * The hysteresis state machine behind the 5%-in-12h price-move alert — pure,
 * isomorphic, no database. `src/lib/alerts/alert-state-store.ts` is the only
 * caller; it is split out here specifically so the transition logic is
 * testable without mocking `@/lib/db`.
 */

export type AlertDirection = 'up' | 'down';

/** A push fires once a move crosses this, in either direction. */
export const FIRE_THRESHOLD = 5;
/** The move must retrace under this before the SAME direction can fire again. */
export const RESET_THRESHOLD = 3;

export interface AlertStateTransition {
  armed: boolean;
  shouldFire: boolean;
}

/**
 * Armed on a retrace below `RESET_THRESHOLD`, fires once on a cross above
 * `FIRE_THRESHOLD` while armed, and is a no-op in between or while already
 * fired-and-not-yet-retraced. `currentArmed === null` — no row has ever been
 * written for this (instrument, direction) — defaults to armed: a symbol
 * crossing the threshold for the first time must fire, not be mistaken for
 * one that already has.
 */
export function nextAlertState(currentArmed: boolean | null, movePct: Money): AlertStateTransition {
  const armed = currentArmed ?? true;
  const absMove = movePct.abs();

  if (absMove.lt(RESET_THRESHOLD)) return { armed: true, shouldFire: false };
  if (armed && absMove.gte(FIRE_THRESHOLD)) return { armed: false, shouldFire: true };
  return { armed, shouldFire: false };
}
