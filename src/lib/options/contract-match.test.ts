import { describe, expect, it } from 'vitest';

import type { OptionContractRef } from '@/lib/market-data/options-types';

import { matchExact, rankAlternatives } from './contract-match';

/**
 * Unit tests for the pure contract matcher. The golden fixture is the Saxo
 * reference case (invented): SNOW call, strike 240, expiry 2027-01-15, whose
 * vendor ticker is `O:SNOW270115C00240000`.
 */

function ref(overrides: Partial<OptionContractRef> = {}): OptionContractRef {
  return {
    ticker: 'O:SNOW270115C00240000',
    underlying: 'SNOW',
    contractType: 'call',
    strikePrice: '240',
    expirationDate: '2027-01-15',
    sharesPerContract: '100',
    ...overrides,
  };
}

/** A one-expiry strike ladder around the reference strike. */
function ladder(): OptionContractRef[] {
  return [
    ref({ ticker: 'O:SNOW270115C00220000', strikePrice: '220' }),
    ref({ ticker: 'O:SNOW270115C00230000', strikePrice: '230' }),
    ref({ ticker: 'O:SNOW270115C00240000', strikePrice: '240' }),
    ref({ ticker: 'O:SNOW270115C00250000', strikePrice: '250' }),
    ref({ ticker: 'O:SNOW270115C00260000', strikePrice: '260' }),
  ];
}

describe('matchExact — Decimal equality, never string equality', () => {
  it('matches the reference case: strike 240 in a list holding O:SNOW270115C00240000', () => {
    expect(matchExact(ladder(), '240')?.ticker).toBe('O:SNOW270115C00240000');
  });

  it('treats 240.00 and 240 as the SAME strike', () => {
    expect(matchExact(ladder(), '240.00')?.ticker).toBe('O:SNOW270115C00240000');
    expect(
      matchExact([ref({ strikePrice: '240.00000000' })], '240')?.ticker,
    ).toBe('O:SNOW270115C00240000');
  });

  it('does not false-match a near strike like 240.5', () => {
    expect(matchExact(ladder(), '240.5')).toBeNull();
  });

  it('returns null on an empty list — no match, no throw', () => {
    expect(matchExact([], '240')).toBeNull();
  });
});

describe('rankAlternatives — nearest real contracts, deterministic', () => {
  it('ranks same-expiry strikes by distance with deterministic ties', () => {
    const ranked = rankAlternatives(ladder(), '242', '2027-01-15');
    // Distances: 240→2, 250→8, 230→12, 260→18, 220→22.
    expect(ranked.map((r) => r.strikePrice)).toEqual(['240', '250', '230', '260', '220']);
  });

  it('breaks an exact strike-distance tie by strike ascending', () => {
    const ranked = rankAlternatives(ladder(), '245', '2027-01-15');
    // 240 and 250 are both 5 away — the lower strike comes first.
    expect(ranked.map((r) => r.strikePrice).slice(0, 2)).toEqual(['240', '250']);
  });

  it('lets expiry distance dominate strike distance across expiries', () => {
    const contracts = [
      // Same strike, one week off the target expiry.
      ref({ ticker: 'O:SNOW270108C00240000', expirationDate: '2027-01-08' }),
      // Far strike, exact expiry — still closer, expiry dominates.
      ref({ ticker: 'O:SNOW270115C00260000', strikePrice: '260' }),
    ];
    const ranked = rankAlternatives(contracts, '240', '2027-01-15');
    expect(ranked[0].ticker).toBe('O:SNOW270115C00260000');
    expect(ranked[1].ticker).toBe('O:SNOW270108C00240000');
  });

  it('respects the suggestion limit', () => {
    expect(rankAlternatives(ladder(), '240', '2027-01-15', 3)).toHaveLength(3);
    expect(rankAlternatives(ladder(), '240', '2027-01-15')).toHaveLength(5);
  });

  it('returns an empty list for an empty candidate set — no throw', () => {
    expect(rankAlternatives([], '240', '2027-01-15')).toEqual([]);
  });

  it('compares strikes as Decimal even with trailing-zero storage forms', () => {
    const contracts = [
      ref({ ticker: 'O:SNOW270115C00241000', strikePrice: '241.00000000' }),
      ref({ ticker: 'O:SNOW270115C00250000', strikePrice: '250' }),
    ];
    const ranked = rankAlternatives(contracts, '240.00', '2027-01-15');
    expect(ranked[0].ticker).toBe('O:SNOW270115C00241000');
  });
});
