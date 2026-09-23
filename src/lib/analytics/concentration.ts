import type Decimal from 'decimal.js';

import { ZERO } from '@/lib/money';

import type { AllocationBreakdown } from './allocation';

/**
 * How concentrated the money is — one pure fold over the TICKER slices the
 * allocation already built.
 *
 * The score is the Herfindahl–Hirschman index over ticker shares, scaled
 * 0–100: Σ(shareᵢ²) × 100 where shareᵢ = valuePLNᵢ / totalPLN as a fraction.
 * 100 means one holding; N equal holdings score 100/N. The ticker dimension
 * is the deliberate unit — it merges the same symbol held across portfolios
 * into ONE position (the `add()` keyed on symbol in `buildAllocation`), which
 * is exactly what "biggest position" means under the All scope.
 *
 * The largest position falls out of the same input: `toSlices` sorts
 * descending by value with a label-ascending tie-break, so `slices[0]` IS the
 * top position by construction — no second sort here.
 *
 * Refusal, never fabrication: a zero total or an empty slice list answers
 * `null`. A score of 0 over nothing would be a confident statement about a
 * portfolio that could not be measured at all. `excludedSymbols` is never
 * read — unpriceable holdings are already outside the fold's input, and they
 * ride through the breakdown unchanged for the caption beside this block.
 */

export interface Concentration {
  /** HHI over ticker shares, scaled 0–100. */
  hhi: Decimal;
  /** The biggest position's symbol — `slices[0]` of the ticker dimension. */
  topSymbol: string;
  topValuePLN: Decimal;
  /** The biggest position's share of the priced total, 0–100. */
  topShare: Decimal;
}

const HUNDRED = '100';

export function buildConcentration(breakdown: AllocationBreakdown): Concentration | null {
  const slices = breakdown.byDimension.ticker;
  const { totalPLN } = breakdown;
  if (totalPLN.isZero() || slices.length === 0) return null;

  let hhi = ZERO;
  for (const slice of slices) {
    const share = slice.valuePLN.div(totalPLN);
    hhi = hhi.plus(share.times(share));
  }

  const top = slices[0];
  return {
    hhi: hhi.times(HUNDRED),
    topSymbol: top.label,
    topValuePLN: top.valuePLN,
    topShare: top.valuePLN.div(totalPLN).times(HUNDRED),
  };
}
