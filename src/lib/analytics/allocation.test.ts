import { describe, expect, it } from 'vitest';

import { dec, ZERO } from '@/lib/money';

import {
  buildAllocation,
  UNKNOWN_KEY,
  UNKNOWN_LABEL,
  type AllocationHolding,
  type InstrumentProfile,
} from './allocation';

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

const profiles = new Map<string, InstrumentProfile>([
  ['i1', { sector: 'Electronic Computers' }],
  ['i2', { sector: 'Pharmaceutical Preparations' }],
  ['i3', { sector: null }],
]);

const sample = [
  holding({ instrumentId: 'i1', symbol: 'AAPL', valuePLN: dec(1000) }),
  holding({
    instrumentId: 'i2',
    symbol: 'NVO',
    valuePLN: dec(600),
    portfolioId: 'p2',
    portfolioName: 'IKE',
  }),
  holding({
    instrumentId: 'i3',
    symbol: 'CDR.WA',
    currency: 'PLN',
    valuePLN: dec(400),
    portfolioId: 'p2',
    portfolioName: 'IKE',
  }),
];

describe('buildAllocation', () => {
  it('produces all four dimensions from one input', () => {
    const result = buildAllocation(sample, profiles, []);
    expect(Object.keys(result.byDimension).sort()).toEqual([
      'currency',
      'portfolio',
      'sector',
      'ticker',
    ]);
    expect(result.totalPLN.toString()).toBe('2000');
  });

  it('sorts each dimension descending by value', () => {
    const { byDimension } = buildAllocation(sample, profiles, []);
    expect(byDimension.ticker.map((s) => s.key)).toEqual(['AAPL', 'NVO', 'CDR.WA']);
  });

  it('makes every dimension sum to the same total', () => {
    const { byDimension, totalPLN } = buildAllocation(sample, profiles, []);
    for (const slices of Object.values(byDimension)) {
      const sum = slices.reduce((acc, s) => acc.plus(s.valuePLN), ZERO);
      expect(sum.toString()).toBe(totalPLN.toString());
    }
  });

  it('sums the per-portfolio slices to the all-portfolios total', () => {
    const { byDimension, totalPLN } = buildAllocation(sample, profiles, []);
    const byPortfolio = new Map(byDimension.portfolio.map((s) => [s.key, s.valuePLN]));
    expect(byPortfolio.get('p1')?.toString()).toBe('1000');
    expect(byPortfolio.get('p2')?.toString()).toBe('1000');
    expect(
      byDimension.portfolio.reduce((acc, s) => acc.plus(s.valuePLN), ZERO).toString(),
    ).toBe(totalPLN.toString());
  });

  it('has percentages summing to 100 within 1e-8', () => {
    const { byDimension } = buildAllocation(sample, profiles, []);
    for (const slices of Object.values(byDimension)) {
      const sum = slices.reduce((acc, s) => acc.plus(s.pct ?? ZERO), ZERO);
      expect(sum.minus(100).abs().lessThan('1e-8')).toBe(true);
    }
  });

  it('names a null sector in its own Unknown bucket', () => {
    const { byDimension } = buildAllocation(sample, profiles, []);
    const unknown = byDimension.sector.find((s) => s.key === UNKNOWN_KEY);
    expect(unknown?.label).toBe(UNKNOWN_LABEL);
    expect(unknown?.valuePLN.toString()).toBe('400');
  });

  it('buckets an instrument with no profile row at all as Unknown', () => {
    const { byDimension } = buildAllocation(sample, new Map(), []);
    expect(byDimension.sector).toHaveLength(1);
    expect(byDimension.sector[0].key).toBe(UNKNOWN_KEY);
  });

  it('merges the same ticker held in two portfolios into one ticker slice', () => {
    const { byDimension } = buildAllocation(
      [
        holding({ valuePLN: dec(300), portfolioId: 'p1', portfolioName: 'Main' }),
        holding({ valuePLN: dec(700), portfolioId: 'p2', portfolioName: 'IKE' }),
      ],
      profiles,
      [],
    );
    expect(byDimension.ticker).toHaveLength(1);
    expect(byDimension.ticker[0].valuePLN.toString()).toBe('1000');
    expect(byDimension.portfolio).toHaveLength(2);
  });

  it('gives a null pct rather than +0.00 % when the total is zero', () => {
    const { byDimension, totalPLN } = buildAllocation(
      [holding({ valuePLN: ZERO })],
      profiles,
      [],
    );
    expect(totalPLN.isZero()).toBe(true);
    expect(byDimension.ticker[0].pct).toBeNull();
  });

  it('leaves zero-quantity positions out entirely', () => {
    const { byDimension, totalPLN } = buildAllocation(
      [holding({ quantity: ZERO, valuePLN: dec(5000) }), holding({ symbol: 'MSFT' })],
      profiles,
      [],
    );
    expect(byDimension.ticker).toHaveLength(1);
    expect(byDimension.ticker[0].key).toBe('MSFT');
    expect(totalPLN.toString()).toBe('1000');
  });

  it('passes the excluded symbols through, named', () => {
    const result = buildAllocation(sample, profiles, ['XYZ.WA']);
    expect(result.excludedSymbols).toEqual(['XYZ.WA']);
  });
});
