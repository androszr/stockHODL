import { describe, expect, it } from 'vitest';

import { dec, ZERO } from '@/lib/money';

import type { AllocationHolding } from './allocation';
import { buildTargetDrift, type TargetWeight } from './target-drift';

/**
 * The drift fold's arithmetic, pinned on exact `Decimal` values — never on
 * formatted strings (formatting is the composer's job and a string
 * comparison would hide a wrong number behind a right-looking spelling).
 */

function holding(over: Partial<AllocationHolding>): AllocationHolding {
  return {
    instrumentId: 'i-aapl',
    symbol: 'AAPL',
    currency: 'USD',
    portfolioId: 'p1',
    portfolioName: 'Main',
    quantity: dec('10'),
    valuePLN: dec('1000'),
    ...over,
  };
}

function target(over: Partial<TargetWeight>): TargetWeight {
  return {
    instrumentId: 'i-aapl',
    symbol: 'AAPL',
    targetPct: dec('50'),
    ...over,
  };
}

describe('buildTargetDrift — the arithmetic', () => {
  it('reports drift 0 and amount 0 for a holding exactly on target', () => {
    const drift = buildTargetDrift(
      [
        holding({ instrumentId: 'i-aapl', symbol: 'AAPL', valuePLN: dec('500') }),
        holding({ instrumentId: 'i-msft', symbol: 'MSFT', valuePLN: dec('500') }),
      ],
      [
        target({ instrumentId: 'i-aapl', symbol: 'AAPL', targetPct: dec('50') }),
        target({ instrumentId: 'i-msft', symbol: 'MSFT', targetPct: dec('50') }),
      ],
    );

    expect(drift).not.toBeNull();
    for (const row of drift!.rows) {
      expect(row.driftPp!.isZero()).toBe(true);
      expect(row.amountPLN!.isZero()).toBe(true);
    }
  });

  it('computes ±10 pp and amounts of exactly 10% of the total for 60/40 vs 50/50', () => {
    const drift = buildTargetDrift(
      [
        holding({ instrumentId: 'i-aapl', symbol: 'AAPL', valuePLN: dec('600') }),
        holding({ instrumentId: 'i-msft', symbol: 'MSFT', valuePLN: dec('400') }),
      ],
      [
        target({ instrumentId: 'i-aapl', symbol: 'AAPL', targetPct: dec('50') }),
        target({ instrumentId: 'i-msft', symbol: 'MSFT', targetPct: dec('50') }),
      ],
    )!;

    const aapl = drift.rows.find((r) => r.symbol === 'AAPL')!;
    const msft = drift.rows.find((r) => r.symbol === 'MSFT')!;

    // AAPL is 10 pp OVERWEIGHT: drift +10, amount −100 (a sell).
    expect(aapl.actualPct!.eq(dec('60'))).toBe(true);
    expect(aapl.driftPp!.eq(dec('10'))).toBe(true);
    expect(aapl.amountPLN!.eq(dec('-100'))).toBe(true);
    // MSFT is 10 pp UNDERWEIGHT: drift −10, amount +100 (a buy).
    expect(msft.actualPct!.eq(dec('40'))).toBe(true);
    expect(msft.driftPp!.eq(dec('-10'))).toBe(true);
    expect(msft.amountPLN!.eq(dec('100'))).toBe(true);
  });

  it('gives a targeted instrument with NO open position actual 0 and a full buy amount', () => {
    const drift = buildTargetDrift(
      [holding({ instrumentId: 'i-aapl', symbol: 'AAPL', valuePLN: dec('2000') })],
      [
        target({ instrumentId: 'i-aapl', symbol: 'AAPL', targetPct: dec('80') }),
        target({ instrumentId: 'i-sold', symbol: 'SOLD', targetPct: dec('20') }),
      ],
    )!;

    const sold = drift.rows.find((r) => r.symbol === 'SOLD')!;
    expect(sold.targetPct!.eq(dec('20'))).toBe(true);
    expect(sold.actualPct!.isZero()).toBe(true);
    expect(sold.driftPp!.eq(dec('-20'))).toBe(true);
    // 20% of 2000: the whole target is a buy.
    expect(sold.amountPLN!.eq(dec('400'))).toBe(true);
  });

  it('carries nulls — never zeros — for a held instrument with no target', () => {
    const drift = buildTargetDrift(
      [
        holding({ instrumentId: 'i-aapl', symbol: 'AAPL', valuePLN: dec('600') }),
        holding({ instrumentId: 'i-free', symbol: 'FREE', valuePLN: dec('400') }),
      ],
      [target({ instrumentId: 'i-aapl', symbol: 'AAPL', targetPct: dec('60') })],
    )!;

    const free = drift.rows.find((r) => r.symbol === 'FREE')!;
    expect(free.targetPct).toBeNull();
    expect(free.driftPp).toBeNull();
    expect(free.amountPLN).toBeNull();
    // The actual share is still real — only the target is absent.
    expect(free.actualPct!.eq(dec('40'))).toBe(true);
  });

  it('refuses per-row figures on a zero-priced total while still listing the targets', () => {
    // A held row whose value is zero: the total is zero, nothing is a share
    // of it, and (target − nothing) must never become a buy of the whole
    // target.
    const drift = buildTargetDrift(
      [holding({ instrumentId: 'i-aapl', symbol: 'AAPL', valuePLN: ZERO })],
      [target({ instrumentId: 'i-aapl', symbol: 'AAPL', targetPct: dec('50') })],
    )!;

    expect(drift.rows).toHaveLength(1);
    const row = drift.rows[0];
    // The target is still LISTED…
    expect(row.targetPct!.eq(dec('50'))).toBe(true);
    // …but every derived figure refuses.
    expect(row.actualPct).toBeNull();
    expect(row.driftPp).toBeNull();
    expect(row.amountPLN).toBeNull();
  });

  it('answers null when there is neither an open holding nor a target', () => {
    expect(buildTargetDrift([], [])).toBeNull();
    // A CLOSED position holds nothing to drift.
    expect(
      buildTargetDrift([holding({ quantity: ZERO, valuePLN: ZERO })], []),
    ).toBeNull();
  });

  it('sums the targets so a shortfall from 100 can be named', () => {
    const drift = buildTargetDrift(
      [holding({ instrumentId: 'i-aapl', symbol: 'AAPL', valuePLN: dec('1000') })],
      [
        target({ instrumentId: 'i-aapl', symbol: 'AAPL', targetPct: dec('60') }),
        target({ instrumentId: 'i-msft', symbol: 'MSFT', targetPct: dec('35') }),
      ],
    )!;

    expect(drift.targetSum.eq(dec('95'))).toBe(true);
  });

  it('orders the rows by symbol, held and targeted interleaved', () => {
    const drift = buildTargetDrift(
      [
        holding({ instrumentId: 'i-msft', symbol: 'MSFT', valuePLN: dec('500') }),
        holding({ instrumentId: 'i-aapl', symbol: 'AAPL', valuePLN: dec('500') }),
      ],
      [target({ instrumentId: 'i-goog', symbol: 'GOOG', targetPct: dec('10') })],
    )!;

    expect(drift.rows.map((r) => r.symbol)).toEqual(['AAPL', 'GOOG', 'MSFT']);
  });

  it('merges the same instrument held across rows before computing its share', () => {
    // Defensive for a caller folding an unscoped holdings set: the same
    // ticker in two portfolios is ONE position here.
    const drift = buildTargetDrift(
      [
        holding({ instrumentId: 'i-aapl', symbol: 'AAPL', portfolioId: 'p1', valuePLN: dec('300') }),
        holding({ instrumentId: 'i-aapl', symbol: 'AAPL', portfolioId: 'p2', valuePLN: dec('200') }),
        holding({ instrumentId: 'i-msft', symbol: 'MSFT', valuePLN: dec('500') }),
      ],
      [target({ instrumentId: 'i-aapl', symbol: 'AAPL', targetPct: dec('50') })],
    )!;

    const aapl = drift.rows.find((r) => r.symbol === 'AAPL')!;
    expect(aapl.actualPct!.eq(dec('50'))).toBe(true);
    expect(aapl.driftPp!.isZero()).toBe(true);
  });
});
