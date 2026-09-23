import { describe, expect, it } from 'vitest';

import { dec, ZERO } from '@/lib/money';
import type { Position } from '@/lib/position-engine';

import { computePortfolioSummary, type SummaryQuote } from './summary';

/** A priced USD position — spread overrides per case. */
function position(overrides: Partial<Position> = {}): Position {
  return {
    instrumentId: 'i-1',
    symbol: 'AAPL',
    displayName: 'Apple Inc.',
    currency: 'USD',
    quantity: dec('10'),
    avgCost: dec('100'),
    costBasis: dec('1000'),
    costBasisPLN: dec('4000'),
    realizedPLN: ZERO,
    oversold: false,
    marketValue: null,
    unrealizedPLN: null,
    ...overrides,
  };
}

function quote(overrides: Partial<SummaryQuote> = {}): SummaryQuote {
  return { price: '110', currency: 'USD', dayChangeAmt: '2', ...overrides };
}

const FX = new Map([['USD', '4']]);

describe('computePortfolioSummary', () => {
  it('totals fully-quoted positions: value, day change and total change in PLN', () => {
    const positions = [
      position(), // 10 × 110 × 4 = 4400 PLN, basis 4000, day 10 × 2 × 4 = 80
      position({
        instrumentId: 'i-2',
        symbol: 'MSFT',
        quantity: dec('5'),
        costBasisPLN: dec('2000'),
      }), // 5 × 110 × 4 = 2200, day 5 × 2 × 4 = 40
    ];
    const quotes = new Map([
      ['AAPL', quote()],
      ['MSFT', quote()],
    ]);

    const s = computePortfolioSummary(positions, quotes, FX);
    expect(s.totalValuePLN?.toString()).toBe('6600');
    expect(s.dayChangePLN?.toString()).toBe('120');
    // 120 on a 6480 open = 1.8518...%
    expect(s.dayChangePct?.toFixed(4)).toBe('1.8519');
    expect(s.totalChangePLN?.toString()).toBe('600'); // 6600 − 6000
    expect(s.totalChangePct?.toString()).toBe('10'); // 600 on 6000
    expect(s.excludedSymbols).toEqual([]);
    expect(s.partialDayChange).toBe(false);
  });

  it('a position with no quote is excluded BY NAME and absent from every total', () => {
    const positions = [
      position(),
      position({ instrumentId: 'i-3', symbol: 'CDR.WA', currency: 'PLN', costBasisPLN: dec('900') }),
    ];
    const s = computePortfolioSummary(positions, new Map([['AAPL', quote()]]), FX);
    expect(s.excludedSymbols).toEqual(['CDR.WA']);
    expect(s.totalValuePLN?.toString()).toBe('4400'); // never 4400 + 0
    expect(s.totalChangePLN?.toString()).toBe('400');
  });

  it('a position with a quote but no FX rate is excluded likewise', () => {
    const s = computePortfolioSummary([position()], new Map([['AAPL', quote()]]), new Map());
    expect(s.excludedSymbols).toEqual(['AAPL']);
    expect(s.totalValuePLN).toBeNull();
    expect(s.dayChangePLN).toBeNull();
    expect(s.totalChangePLN).toBeNull();
  });

  it('a currency-mismatched quote is no quote at all — the engine’s guard, mirrored', () => {
    const s = computePortfolioSummary(
      [position({ currency: 'PLN' })],
      new Map([['AAPL', quote()]]), // USD quote for a PLN instrument
      FX,
    );
    expect(s.excludedSymbols).toEqual(['AAPL']);
    expect(s.totalValuePLN).toBeNull();
  });

  it('a priced position without dayChangeAmt flags partialDayChange, never a fake zero day', () => {
    const positions = [
      position(),
      position({ instrumentId: 'i-2', symbol: 'MSFT', costBasisPLN: dec('4000') }),
    ];
    const quotes = new Map([
      ['AAPL', quote()],
      ['MSFT', quote({ dayChangeAmt: null })],
    ]);
    const s = computePortfolioSummary(positions, quotes, FX);
    expect(s.partialDayChange).toBe(true);
    expect(s.dayChangePLN?.toString()).toBe('80'); // AAPL only — a floor, flagged
    expect(s.totalValuePLN?.toString()).toBe('8800'); // both still valued in full
  });

  it('no priced position with day data → day change null, not 0', () => {
    const s = computePortfolioSummary(
      [position()],
      new Map([['AAPL', quote({ dayChangeAmt: null })]]),
      FX,
    );
    expect(s.dayChangePLN).toBeNull();
    expect(s.dayChangePct).toBeNull();
    expect(s.partialDayChange).toBe(true);
  });

  it('zero cost basis → null total-change percent, never +∞ or 0.00%', () => {
    const s = computePortfolioSummary(
      [position({ costBasisPLN: ZERO })],
      new Map([['AAPL', quote()]]),
      FX,
    );
    expect(s.totalChangePct).toBeNull();
    expect(s.totalChangePLN?.toString()).toBe('4400');
  });

  it('an oversold zero-quantity position contributes nothing and is not "excluded"', () => {
    const positions = [
      position(),
      position({ instrumentId: 'i-4', symbol: 'OOPS', quantity: ZERO, oversold: true, avgCost: null }),
    ];
    const s = computePortfolioSummary(positions, new Map([['AAPL', quote()]]), FX);
    expect(s.totalValuePLN?.toString()).toBe('4400');
    expect(s.excludedSymbols).toEqual([]);
  });

  it('a PLN position needs no FX row — the rate short-circuits to 1', () => {
    const s = computePortfolioSummary(
      [position({ currency: 'PLN', costBasisPLN: dec('1000') })],
      new Map([['AAPL', quote({ currency: 'PLN', price: '110' })]]),
      new Map(),
    );
    expect(s.totalValuePLN?.toString()).toBe('1100');
    expect(s.excludedSymbols).toEqual([]);
  });
});
