/**
 * How big a day's move has to be to earn each bar height on the trend strip.
 *
 * PURE and free of imports on purpose: the thresholds are the design, and a
 * design constant that needs a database to read is a design nobody can check.
 *
 * **Why this is a parameter and not a constant.** The strip's four heights are
 * meant to separate a quiet session from a violent one at a glance. That only
 * works if the bands sit where the instrument's own moves actually fall. A
 * share that moves 3% has had a big day; an option that moves 3% has had a
 * dull one, because option premiums routinely swing ten or thirty percent on
 * an ordinary session. Reusing the equity bands on an option tile pegs every
 * bar at full height — five identical tall bars, which carry exactly as much
 * information as five identically-shaded dots. That is the wall of noise the
 * height-not-shade rule exists to prevent, arriving through the other door.
 *
 * So "analogous" between the two tiles means *reads the same*, not *uses the
 * same numbers*.
 *
 * Both scales stay ABSOLUTE. Self-normalising each instrument to its own five
 * days was considered and rejected for the equity strip and is rejected again
 * here for the same reason: it makes a dead week and a violent week look
 * identical, which is the opposite of what a glance across a grid is for.
 */
export interface TrendScale {
  /** Below this absolute percent a day has NO SIDE — it reports `neutral`. */
  flatMaxPct: number;
  /** Below this, a level-1 (shortest) bar. */
  level1MaxPct: number;
  /** Below this, a level-2 bar; at or above it, full height. */
  level2MaxPct: number;
}

/**
 * Equities. Unchanged from the strip's first implementation
 * (`plans/2026-08-22-ios-five-day-trend-lights.md`) — moving these would
 * redraw every stock tile in the app, so they are pinned by their own tests.
 */
export const EQUITY_TREND_SCALE: TrendScale = {
  flatMaxPct: 0.25,
  level1MaxPct: 1,
  level2MaxPct: 3,
};

/**
 * Options, on the model marks the tiles already price from.
 *
 * MEASURED, not guessed — a one-off measurement script (retired 2026-09-23)
 * printed the decile distribution of absolute session-over-session mark
 * changes across the tracked book, and these bands were read off it so that
 * the four heights split the book's own sessions into four populated groups
 * instead of dumping nine in ten into the top one. Re-measure when the book
 * changes character (a very short-dated or very far out-of-the-money contract
 * moves in a different world from a LEAP) and move the bands rather than
 * living with a wall.
 *
 * Measured 2026-08-22 over 21 contracts and 403 graded sessions (the rest of
 * the 2 499 slots were holes — which is itself the reason the grader holes
 * them rather than walking adjacent rows). Deciles of |change|, percent:
 *
 *   p10 2.1 · p20 3.7 · p30 5.7 · p40 7.6 · p50 9.7
 *   p60 11.5 · p70 15.4 · p80 20.0 · p90 27.5 · p95 36.5 · max 112.0
 *
 * Against that distribution these bands put 9% of sessions flat, 33% at level
 * 1, 37% at level 2 and 20% at full height — four populated groups, with full
 * height kept for the top fifth rather than spent on the median. The obvious
 * alternative, a quartile ladder (4.8 / 9.7 / 17.3), was rejected: it calls a
 * 4% session flat, and on an option premium 4% is a real move that the strip
 * would then be showing as nothing happening.
 */
export const OPTION_TREND_SCALE: TrendScale = {
  flatMaxPct: 2,
  level1MaxPct: 8,
  level2MaxPct: 20,
};

/**
 * A currency pair. USD/PLN moves a fraction of a percent on an ordinary day,
 * so on the equity bands almost every session would sit at level 1 and the
 * strip would say nothing. Bands chosen for a typical 0,3–0,5% daily range:
 * flat under a tenth, full height only on a move a headline would call one.
 */
export const FX_TREND_SCALE: TrendScale = {
  flatMaxPct: 0.1,
  level1MaxPct: 0.35,
  level2MaxPct: 0.8,
};
