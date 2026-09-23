/**
 * The nightly refresh-history budget — pure, no I/O, arrays in / arrays out
 * (the testing shape of `calendar-merge.ts`).
 *
 * Before 2026-08-14 the cron route truncated `[...held, ...watched]` with a
 * blind `.slice(0, 50)`: held always sorted first, so at ≥50 held
 * instruments no watched instrument was EVER backfilled — watched charts
 * stayed permanently empty, silently. The fix reserves a fixed slice for
 * watched instruments (user decision: 10 of 50; interleaving and raising the
 * cap were both declined), held keeping priority for the rest. An under-used
 * reservation returns to held, and unused held budget flows to watched.
 * Whatever misses the cut comes back named in `dropped*` — the caller logs
 * it, never a silent cap.
 */

/**
 * Sanity bound per run: a normal night is one bar per instrument, and the
 * single-user portfolio is dozens of positions at most. Instruments beyond
 * the bound catch up tomorrow — or on the next chart view, which backfills
 * the same cache.
 */
export const MAX_INSTRUMENTS_PER_RUN = 50;

/** Slots guaranteed to watched instruments when they need them. */
export const WATCHED_RESERVED_SLOTS = 10;

export function planBackfillRun<T>(
  held: readonly T[],
  watched: readonly T[],
): { take: T[]; droppedHeld: T[]; droppedWatched: T[] } {
  // Reserve only what watched can actually use — reserving 10 empty slots
  // when 3 stocks are watched would waste 7 held slots.
  const reserved = Math.min(WATCHED_RESERVED_SLOTS, watched.length);
  const heldBudget = MAX_INSTRUMENTS_PER_RUN - reserved;

  const takenHeld = held.slice(0, heldBudget);
  const takenWatched = watched.slice(0, MAX_INSTRUMENTS_PER_RUN - takenHeld.length);

  return {
    take: [...takenHeld, ...takenWatched],
    droppedHeld: held.slice(takenHeld.length),
    droppedWatched: watched.slice(takenWatched.length),
  };
}
