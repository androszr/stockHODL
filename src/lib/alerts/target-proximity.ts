import type Decimal from 'decimal.js';

import type { TargetStatusContract } from '@/lib/api/contracts/price-targets';
import type { TargetGroupContract } from '@/lib/api/contracts/watchlist';
import { dec, fmtMoney, fmtPctUnsigned, pctChange, splitMoney } from '@/lib/money';

/**
 * How close a price is to the target lines drawn on it — the ONE place the
 * semantics live (plans/2026-09-15-watchlist-target-proximity.md). Pure and
 * isomorphic like `watchlist-payload.ts`: no `server-only`, no db, no fetch.
 * The watchlist composer, the instrument detail and both target mutations
 * all call in here, which is what keeps a tile and the stock's own screen
 * from ever telling different stories.
 *
 * All arithmetic on `dec()`; only formatted strings leave (non-negotiable
 * #1). Distance is measured RELATIVE TO THE CURRENT PRICE —
 * `|pctChange(price → target)|` — because the figure answers "how far does
 * the price have to move", and that move starts from where the price is now.
 * The sentence says exactly that: "Needs to fall 26,02% to reach your
 * 110,00 USD line" (plans/2026-09-28-watchlist-grid-extended-hours.md — the
 * earlier wording put the figure beside the words "above" or "below" your
 * line, which names a gap it never measured, since the
 * gap measured from the LINE is a different percentage).
 */

/** "Near a target" means within this many percent of a waiting line —
 *  INCLUSIVE: a stock sitting at exactly 5,00% is near. */
export const NEAR_TARGET_THRESHOLD_PCT = dec('5');

/**
 * One target line, as this module needs it. `PriceTargetContract` satisfies
 * it structurally, so store rows flow in without mapping.
 */
export interface TargetLine {
  /** Decimal string — `dec()`-parsed here, never a JS number. */
  targetPrice: string;
  /** Null = still waiting. A hit line never counts toward proximity, but
   *  its existence drives `hitOnly`. */
  hitAtMs: number | null;
  createdAtMs: number;
}

/** The nearest WAITING line and its unsigned Decimal distance. */
interface NearestLine {
  line: TargetLine;
  distance: Decimal;
}

/** A price string usable as a distance base. `pctChange` refuses a zero
 *  base, and this module maps that to "unpriced" — never to a fabricated
 *  0,00%. */
function usablePrice(currentPrice: string | null): Decimal | null {
  if (currentPrice === null) return null;
  const price = dec(currentPrice);
  return price.isZero() ? null : price;
}

/** The target amount without its currency, for a tile's "to 110" suffix:
 *  no decimals for a whole target ("110"), two otherwise ("167,70"). String
 *  typesetting over `fmtMoney` — never parsed back. */
function shortPrice(target: Decimal, currency: string): string {
  return splitMoney(fmtMoney(target, currency, target.isInteger() ? 0 : 2)).amount;
}

/** Smallest distance wins; a tie goes to the OLDEST line. */
function nearestPending(lines: readonly TargetLine[], price: Decimal): NearestLine | null {
  let best: NearestLine | null = null;
  for (const line of lines) {
    if (line.hitAtMs !== null) continue;
    const change = pctChange(price, dec(line.targetPrice));
    if (change === null) continue; // unreachable: price is non-zero here
    const distance = change.abs();
    if (
      best === null ||
      distance.lt(best.distance) ||
      (distance.eq(best.distance) && line.createdAtMs < best.line.createdAtMs)
    ) {
      best = { line, distance };
    }
  }
  return best;
}

/**
 * The status readout for one instrument, or null when it has no lines at
 * all. The full decision table (pinned by the unit tests):
 *
 * - no lines            → null (group `none`, no marker)
 * - only hit lines      → `hitOnly` (group `none`, tile says "Hit")
 * - pending, no usable price → group `set`, `side: null`, text `—`
 * - pending, priced     → nearest waiting line; `near` iff distance ≤ 5%
 *   (inclusive); distance zero → "at your … line", `side: null`; otherwise
 *   "Needs to fall/rise X% to reach your … line"
 *
 * `targetShort` is the nearest line's price without currency for the priced
 * branches, null for hit-only and unpriced.
 */
export function targetStatusFor(
  lines: readonly TargetLine[],
  currentPrice: string | null,
  currency: string,
): TargetStatusContract | null {
  if (lines.length === 0) return null;

  const pending = lines.filter((l) => l.hitAtMs === null);
  if (pending.length === 0) {
    // Every line was reached. The sentence names the most recently hit one —
    // the freshest fact about this stock's lines.
    const latest = lines.reduce((a, b) => ((b.hitAtMs ?? 0) > (a.hitAtMs ?? 0) ? b : a));
    return {
      text: 'Hit',
      sentence: `Your ${fmtMoney(dec(latest.targetPrice), currency)} line has been hit`,
      side: null,
      near: false,
      hitOnly: true,
      targetShort: null,
    };
  }

  const price = usablePrice(currentPrice);
  if (price === null) {
    // A line is waiting but there is nothing to measure from. `set`, never a
    // fabricated distance.
    return {
      text: '—',
      sentence: 'A target line is set — no current price to measure from',
      side: null,
      near: false,
      hitOnly: false,
      targetShort: null,
    };
  }

  const nearest = nearestPending(pending, price);
  if (nearest === null) return null; // unreachable: pending is non-empty

  const target = dec(nearest.line.targetPrice);
  const money = fmtMoney(target, currency);
  const targetShort = shortPrice(target, currency);
  const near = nearest.distance.lte(NEAR_TARGET_THRESHOLD_PCT);

  if (nearest.distance.isZero()) {
    return {
      text: fmtPctUnsigned(nearest.distance),
      sentence: `At your ${money} line`,
      side: null,
      near,
      hitOnly: false,
      targetShort,
    };
  }

  // Where the PRICE sits relative to the line, from the live compare — never
  // the persisted `direction`, which a gapped-past line would contradict. A
  // price above the line has to fall to reach it; below, it has to rise.
  const side = price.lt(target) ? 'below' : 'above';
  const text = fmtPctUnsigned(nearest.distance);
  return {
    text,
    sentence:
      side === 'above'
        ? `Needs to fall ${text} to reach your ${money} line`
        : `Needs to rise ${text} to reach your ${money} line`,
    side,
    near,
    hitOnly: false,
    targetShort,
  };
}

/**
 * The composer's sort key: unsigned Decimal distance to the nearest WAITING
 * line, or null when there is no waiting line or no usable price. Null ranks
 * LAST within a group (unpriced `set` items after priced ones).
 */
export function proximityRank(
  lines: readonly TargetLine[],
  currentPrice: string | null,
): Decimal | null {
  const price = usablePrice(currentPrice);
  if (price === null) return null;
  return nearestPending(lines, price)?.distance ?? null;
}

/** Status → watchlist group. Hit-only files under `none` like no lines at
 *  all — the tile's "Hit" note is what keeps the history visible. */
export function targetGroupFor(status: TargetStatusContract | null): TargetGroupContract {
  if (status === null || status.hitOnly) return 'none';
  return status.near ? 'near' : 'set';
}
