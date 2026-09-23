import type Decimal from 'decimal.js';

import { dec, pctChange, ZERO } from '@/lib/money';
import type { Position } from '@/lib/position-engine';

/**
 * Pure portfolio-summary math — isomorphic like the position engine: no
 * `server-only`, no env, no fetch, Decimal in and Decimal out via
 * `src/lib/money.ts`.
 *
 * The exclusion semantics are the point of this module. A position the
 * caller cannot price (no usable quote, no FX rate) goes to
 * `excludedSymbols` and contributes NOTHING to any total — treating it as
 * zero would silently misstate the portfolio's value, which is worse than
 * admitting the gap. The UI names the excluded tickers.
 */

/** What the summary needs to know about one symbol's latest quote. */
export interface SummaryQuote {
  /** Decimal string, per share, in `currency`. */
  price: string;
  /** Quote currency — must match the instrument's, same guard as the engine. */
  currency: string;
  /** Regular-session change per share, decimal string; null when unknown. */
  dayChangeAmt: string | null;
}

export interface PortfolioSummary {
  /** Σ quantity × price × fx over priced positions; null when none priced. */
  totalValuePLN: Decimal | null;
  /** Σ quantity × dayChangeAmt × fx; null when no priced position had one. */
  dayChangePLN: Decimal | null;
  dayChangePct: Decimal | null;
  /** Σ unrealized PLN over priced positions. */
  totalChangePLN: Decimal | null;
  totalChangePct: Decimal | null;
  /** Open positions that could not be priced — named, never zeroed. */
  excludedSymbols: string[];
  /** True when a PRICED position lacked day-change data: the day figures —
   *  the amount AND the percentage (a partial numerator over the full
   *  portfolio's open value) — are floors, and the UI caveat must say so. */
  partialDayChange: boolean;
}

export function computePortfolioSummary(
  positions: readonly Position[],
  quotes: ReadonlyMap<string, SummaryQuote>,
  fxRates: ReadonlyMap<string, string>,
): PortfolioSummary {
  const excludedSymbols: string[] = [];
  let partialDayChange = false;
  let pricedCount = 0;
  let totalValue = ZERO;
  let basisSum = ZERO;
  let unrealizedSum = ZERO;
  let dayChangeSum: Decimal | null = null;

  for (const p of positions) {
    // Zero-quantity rows (cleanly closed or oversold-at-zero) hold nothing —
    // no market value to state, nothing to exclude.
    if (!p.quantity.greaterThan(0)) continue;

    const quote = quotes.get(p.symbol);
    // A quote in the wrong currency would be multiplied by the wrong FX rate —
    // the same guard the position engine applies.
    const usable = quote && quote.currency === p.currency ? quote : undefined;
    const rate = usable ? (p.currency === 'PLN' ? '1' : fxRates.get(p.currency)) : undefined;
    if (!usable || rate === undefined) {
      excludedSymbols.push(p.symbol);
      continue;
    }

    pricedCount++;
    const fx = dec(rate);
    const value = p.quantity.times(dec(usable.price)).times(fx);
    totalValue = totalValue.plus(value);
    basisSum = basisSum.plus(p.costBasisPLN);
    unrealizedSum = unrealizedSum.plus(value.minus(p.costBasisPLN));

    if (usable.dayChangeAmt === null) {
      // Priced but with an unknown day move: the total stays honest, the day
      // figure becomes a floor and says so via the flag.
      partialDayChange = true;
    } else {
      dayChangeSum = (dayChangeSum ?? ZERO).plus(p.quantity.times(dec(usable.dayChangeAmt)).times(fx));
    }
  }

  if (pricedCount === 0) {
    return {
      totalValuePLN: null,
      dayChangePLN: null,
      dayChangePct: null,
      totalChangePLN: null,
      totalChangePct: null,
      excludedSymbols,
      partialDayChange,
    };
  }

  return {
    totalValuePLN: totalValue,
    dayChangePLN: dayChangeSum,
    // The day's move against where the portfolio STARTED the day.
    dayChangePct: dayChangeSum === null ? null : pctChange(totalValue.minus(dayChangeSum), totalValue),
    totalChangePLN: unrealizedSum,
    // pctChange returns null on a zero basis — rendered "—", never +0.00%.
    totalChangePct: pctChange(basisSum, basisSum.plus(unrealizedSum)),
    excludedSymbols,
    partialDayChange,
  };
}
