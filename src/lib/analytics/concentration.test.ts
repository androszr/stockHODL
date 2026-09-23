import { describe, expect, it } from 'vitest';

import { dec, ZERO } from '@/lib/money';

import { buildAllocation, type AllocationHolding } from './allocation';
import { buildConcentration } from './concentration';

/**
 * The fold is driven through REAL `buildAllocation` output — the composition
 * `composeAnalyticsView` actually runs — so the ticker-dimension merge and
 * the descending sort are exercised, not restated.
 */

function holding(over: Partial<AllocationHolding>): AllocationHolding {
  return {
    instrumentId: 'i1',
    symbol: 'AAPL',
    currency: 'USD',
    portfolioId: 'p1',
    portfolioName: 'Main',
    quantity: dec(10),
    valuePLN: dec(1000),
    ...over,
  };
}

function fold(holdings: AllocationHolding[], excluded: string[] = []) {
  return buildConcentration(buildAllocation(holdings, new Map(), excluded));
}

describe('buildConcentration', () => {
  it('scores a single holding exactly 100, and names it', () => {
    const result = fold([holding({ symbol: 'AAPL', valuePLN: dec(1234) })]);
    expect(result).not.toBeNull();
    expect(result?.hhi.toString()).toBe('100');
    expect(result?.topSymbol).toBe('AAPL');
    expect(result?.topShare.toString()).toBe('100');
    expect(result?.topValuePLN.toString()).toBe('1234');
  });

  it('scores four equal holdings 25', () => {
    const result = fold(
      ['AAPL', 'MSFT', 'NVO', 'CDR.WA'].map((symbol, index) =>
        holding({ instrumentId: `i${index}`, symbol, valuePLN: dec(500) }),
      ),
    );
    expect(result?.hhi.toString()).toBe('25');
  });

  it('scores a 3:1 two-holding split 62.5, with the top share at 75', () => {
    const result = fold([
      holding({ instrumentId: 'i1', symbol: 'AAPL', valuePLN: dec(3000) }),
      holding({ instrumentId: 'i2', symbol: 'MSFT', valuePLN: dec(1000) }),
    ]);
    // The RAW figure before formatting — the view test asserts the half-up
    // '63' string this becomes.
    expect(result?.hhi.toString()).toBe('62.5');
    expect(result?.topSymbol).toBe('AAPL');
    expect(result?.topShare.toString()).toBe('75');
  });

  it('refuses a zero-value total with null, never a fabricated 0', () => {
    expect(fold([holding({ valuePLN: ZERO })])).toBeNull();
  });

  it('refuses an empty holding set with null', () => {
    expect(fold([])).toBeNull();
  });

  it('counts the same ticker held in two portfolios as ONE position', () => {
    // The ticker dimension merges them, so this is one 100 %-concentrated
    // position — not two halves scoring 50.
    const result = fold([
      holding({ valuePLN: dec(300), portfolioId: 'p1', portfolioName: 'Main' }),
      holding({ valuePLN: dec(700), portfolioId: 'p2', portfolioName: 'IKE' }),
    ]);
    expect(result?.hhi.toString()).toBe('100');
    expect(result?.topSymbol).toBe('AAPL');
    expect(result?.topValuePLN.toString()).toBe('1000');
  });

  it('is unchanged by excluded symbols — they ride through, never re-enter', () => {
    const holdings = [
      holding({ instrumentId: 'i1', symbol: 'AAPL', valuePLN: dec(3000) }),
      holding({ instrumentId: 'i2', symbol: 'MSFT', valuePLN: dec(1000) }),
    ];
    const without = fold(holdings);
    const withExcluded = fold(holdings, ['XYZ.WA']);
    expect(withExcluded?.hhi.toString()).toBe(without?.hhi.toString());
    expect(withExcluded?.topSymbol).toBe(without?.topSymbol);
    expect(withExcluded?.topShare.toString()).toBe(without?.topShare.toString());
  });
});
