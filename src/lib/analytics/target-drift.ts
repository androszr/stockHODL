import type Decimal from 'decimal.js';

import { ZERO } from '@/lib/money';

import type { AllocationHolding } from './allocation';

/**
 * Target drift — one pure fold over the SAME priced holdings the allocation
 * renders, so the drift figures and the breakdown beside them can never
 * disagree about what a holding is worth.
 *
 * Everything stays on `Decimal`; formatting is the composer's job. The fold
 * never reads `excludedSymbols` — unpriceable holdings are already outside
 * its input, exactly as they are outside `buildAllocation`'s.
 *
 * Three doctrines, all inherited:
 *
 * - **Blank ≠ zero.** A held instrument with no target row carries
 *   `targetPct: null` and no drift/amount — a fabricated `0` target would
 *   read as "sell everything".
 * - **Refusal, never fabrication.** A zero priced total answers null per-row
 *   figures (the allocation's own `pct: null` rule): `(target − nothing)`
 *   must never render as a buy of the whole target.
 * - **A sold holding keeps its target.** A targeted instrument with no open
 *   position is a row with actual 0 and a full buy amount, not an omission.
 */

/** One stored target, joined to its instrument for the symbol. */
export interface TargetWeight {
  instrumentId: string;
  symbol: string;
  /** Percent of the portfolio, 0 < x ≤ 100. */
  targetPct: Decimal;
}

export interface TargetDriftRow {
  instrumentId: string;
  symbol: string;
  /** Null = no target set for this holding — never a zero. */
  targetPct: Decimal | null;
  /** Share of the priced total, 0–100; null when the total is zero. */
  actualPct: Decimal | null;
  /** Signed percentage-POINT delta, actual − target; null without both. */
  driftPp: Decimal | null;
  /**
   * PLN to trade to land exactly on target: positive = buy, negative = sell.
   * Null when there is no target or the total is unpriced.
   */
  amountPLN: Decimal | null;
}

export interface TargetDrift {
  /** Union of held and targeted instruments, symbol-ascending. */
  rows: TargetDriftRow[];
  /** Σ `valuePLN` over the open holdings — the denominator. */
  totalPLN: Decimal;
  /** Σ `targetPct` over the target rows — the ≠100 note's input. */
  targetSum: Decimal;
}

const HUNDRED = '100';

export function buildTargetDrift(
  holdings: readonly AllocationHolding[],
  targets: readonly TargetWeight[],
): TargetDrift | null {
  // Sum per instrument over OPEN holdings. The input is per (instrument,
  // portfolio); under the one-portfolio scope this fold serves that is one
  // row each, but summing keeps the fold correct for any caller.
  const valueByInstrument = new Map<string, { symbol: string; valuePLN: Decimal }>();
  let totalPLN = ZERO;
  for (const holding of holdings) {
    if (!holding.quantity.greaterThan(0)) continue;
    totalPLN = totalPLN.plus(holding.valuePLN);
    const existing = valueByInstrument.get(holding.instrumentId);
    if (existing) existing.valuePLN = existing.valuePLN.plus(holding.valuePLN);
    else {
      valueByInstrument.set(holding.instrumentId, {
        symbol: holding.symbol,
        valuePLN: holding.valuePLN,
      });
    }
  }

  const targetByInstrument = new Map<string, TargetWeight>();
  let targetSum = ZERO;
  for (const target of targets) {
    targetByInstrument.set(target.instrumentId, target);
    targetSum = targetSum.plus(target.targetPct);
  }

  // Nothing held AND nothing targeted: there is no drift to state.
  if (valueByInstrument.size === 0 && targetByInstrument.size === 0) return null;

  // The union, symbol-ascending. A targeted-but-sold instrument is a row; a
  // held-but-untargeted instrument is a row.
  const members = new Map<string, string>();
  for (const [id, { symbol }] of valueByInstrument) members.set(id, symbol);
  for (const [id, target] of targetByInstrument) {
    if (!members.has(id)) members.set(id, target.symbol);
  }
  const ordered = [...members].sort((a, b) =>
    a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );

  const priced = totalPLN.greaterThan(0);

  const rows: TargetDriftRow[] = ordered.map(([instrumentId, symbol]) => {
    const targetPct = targetByInstrument.get(instrumentId)?.targetPct ?? null;
    // A zero total prices NOTHING: actual is null (never a fake 0,00%), and
    // drift/amount refuse with it — even for a targeted row.
    const valuePLN = valueByInstrument.get(instrumentId)?.valuePLN ?? ZERO;
    const actualPct = priced ? valuePLN.div(totalPLN).times(HUNDRED) : null;

    if (targetPct === null || actualPct === null) {
      return { instrumentId, symbol, targetPct, actualPct, driftPp: null, amountPLN: null };
    }

    return {
      instrumentId,
      symbol,
      targetPct,
      actualPct,
      driftPp: actualPct.minus(targetPct),
      // Positive = buy, negative = sell: the amount that lands this holding
      // exactly on target given today's priced total.
      amountPLN: targetPct.minus(actualPct).div(HUNDRED).times(totalPLN),
    };
  });

  return { rows, totalPLN, targetSum };
}
