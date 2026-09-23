import type { Candle } from '@/lib/market-data/provider';
import { dec, type Money } from '@/lib/money';

import type { AlertDirection } from './dedupe';

/**
 * The price-target crossing test — pure, Decimal-only, no I/O (the
 * `dedupe.ts` precedent). `/api/cron/check-price-alerts` feeds it the same
 * intraday bars the 5%-move check already fetched.
 *
 * Only bars with `t >= createdAtMs` participate: the fetch window is 13h wide
 * and a spike from BEFORE the target existed must not fire it. Since `t` is
 * the bar START, this also skips the partial bar spanning the creation
 * instant — biased toward NOT firing on pre-existing data, which is the right
 * bias.
 *
 * Touch counts ("rises to/above", per the interview answer): `'up'` crosses
 * when any qualifying bar's high reaches the target, `'down'` when any low
 * reaches it. A bar that gapped past the line entirely still satisfies the
 * same comparison — the high (or low) is beyond the target too.
 */
export function crossedTarget(
  candles: readonly Candle[],
  targetPrice: Money,
  direction: AlertDirection,
  createdAtMs: number,
): boolean {
  for (const candle of candles) {
    if (candle.t < createdAtMs) continue;
    if (direction === 'up') {
      if (dec(candle.high).gte(targetPrice)) return true;
    } else if (dec(candle.low).lte(targetPrice)) {
      return true;
    }
  }
  return false;
}
