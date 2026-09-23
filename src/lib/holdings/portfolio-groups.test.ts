import { describe, expect, it } from 'vitest';

import { dec, fmtMoney, fmtPct, fmtQuantity } from '@/lib/money';
import { computePositions } from '@/lib/position-engine';

import { composeLivePayload, type HoldingQuote, type HoldingsInputs } from './live-payload';
import { computePortfolioGroups, type PortfolioGroupRow } from './portfolio-groups';

/**
 * The per-portfolio composer contract: each group is its own position-engine
 * run over that portfolio's rows alone (never a slice of the combined
 * position), formatted with exactly the combined card's conventions — same
 * guard chain, same '—'-over-fake-zero rules, same '+'-signed PLN.
 */

let seq = 0;
function row(overrides: Partial<PortfolioGroupRow> = {}): PortfolioGroupRow {
  seq += 1;
  return {
    id: `t${seq}`,
    instrumentId: 'i1',
    symbol: 'AAPL',
    displayName: 'Apple Inc.',
    currency: 'USD',
    side: 'buy',
    quantity: '10',
    price: '100',
    fees: '0',
    fxRateToBase: '4.00000000',
    tradeDate: '2026-01-05',
    createdAt: new Date('2026-01-05T12:00:00Z'),
    portfolioId: 'p1',
    portfolioName: 'MBank',
    portfolioSortOrder: 0,
    portfolioCreatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function inIkze(overrides: Partial<PortfolioGroupRow> = {}): PortfolioGroupRow {
  return row({
    portfolioId: 'p2',
    portfolioName: 'IKZE',
    portfolioSortOrder: 1,
    portfolioCreatedAt: new Date('2025-06-01T00:00:00Z'),
    ...overrides,
  });
}

function quote(overrides: Partial<HoldingQuote> = {}): HoldingQuote {
  return {
    price: '110',
    currency: 'USD',
    prevClose: '105',
    dayChangeAmt: '5',
    dayChangePct: '4.7619',
    extendedChangePct: null,
    extendedKind: null,
    extendedEndedAtMs: null,
    extendedLive: false,
    ...overrides,
  };
}

const QUOTES = new Map([['AAPL', quote()]]);
const FX = new Map([['USD', '4.00']]);

describe('computePortfolioGroups — engine per partition', () => {
  it('splits shares per portfolio and the split sums to the combined engine run', () => {
    const rows = [row({ quantity: '10' }), inIkze({ quantity: '5' })];
    const groups = computePortfolioGroups(rows, QUOTES, FX);

    expect(groups).toHaveLength(2);
    expect(groups[0].portfolioName).toBe('MBank');
    expect(groups[0].summary.quantity).toBe(fmtQuantity(dec('10')));
    expect(groups[1].portfolioName).toBe('IKZE');
    expect(groups[1].summary.quantity).toBe(fmtQuantity(dec('5')));

    // Shares always sum exactly to the combined position's quantity.
    const combined = computePositions(rows, QUOTES, FX)[0];
    expect(combined.quantity.equals(dec('10').plus(dec('5')))).toBe(true);
  });

  it('per-portfolio avg cost is that portfolio\'s own average, not the combined one', () => {
    const rows = [row({ quantity: '10', price: '100' }), inIkze({ quantity: '10', price: '200' })];
    const groups = computePortfolioGroups(rows, QUOTES, FX);

    expect(groups[0].summary.avgCost).toBe(fmtMoney(dec('100'), 'USD'));
    expect(groups[1].summary.avgCost).toBe(fmtMoney(dec('200'), 'USD'));

    // The combined average (150) belongs to the card, not to either group.
    const combined = computePositions(rows, QUOTES, FX)[0];
    expect(combined.avgCost!.equals(dec('150'))).toBe(true);
    expect(groups[0].summary.avgCost).not.toBe(fmtMoney(dec('150'), 'USD'));
  });

  it('prices value/unrealized from the given quote + FX, formatted exactly like the card', () => {
    const rows = [row({ quantity: '10', price: '100' })];
    const groups = computePortfolioGroups(rows, QUOTES, FX);
    const s = groups[0].summary;

    // 10 × 110 × 4 = 4400 PLN; basis 10 × 100 × 4 = 4000 → unrealized +400 (10%).
    expect(s.valuePLN).toBe(fmtMoney(dec('4400'), 'PLN'));
    expect(s.costBasisPLN).toBe(fmtMoney(dec('4000'), 'PLN'));
    expect(s.unrealizedPLN).toBe(`+${fmtMoney(dec('400'), 'PLN')}`);
    expect(s.unrealizedPct).toBe(fmtPct(dec('10')));
    expect(s.direction).toBe('gain');

    // Single portfolio ⇒ the group IS the combined position: its strings must
    // match `composeLivePayload`'s for the same inputs, character for character.
    const inputs: HoldingsInputs = {
      engineTxs: rows,
      fxRates: FX,
      market: {
        status: 'open',
        nextTransitionAtMs: null,
        nextTransitionKind: null,
        pollingResumesAtMs: null,
      },
      hasPollableSymbols: true,
    };
    const h = composeLivePayload(inputs, QUOTES).holdings[0];
    expect(s.valuePLN).toBe(h.valuePLN);
    expect(s.unrealizedPLN).toBe(h.unrealizedPLN);
    expect(s.unrealizedPct).toBe(h.unrealizedPct);
    expect(s.direction).toBe(h.direction);
  });

  it('orders by sortOrder asc, then createdAt asc, then name asc — the Portfolios-screen order', () => {
    const rows = [
      row({ portfolioId: 'pa', portfolioName: 'Zeta', portfolioSortOrder: 2 }),
      row({ portfolioId: 'pb', portfolioName: 'Alpha', portfolioSortOrder: 1 }),
      row({
        portfolioId: 'pc',
        portfolioName: 'Beta',
        portfolioSortOrder: 1,
        portfolioCreatedAt: new Date('2024-01-01T00:00:00Z'),
      }),
      row({
        portfolioId: 'pd',
        portfolioName: 'Aardvark',
        portfolioSortOrder: 1,
        portfolioCreatedAt: new Date('2025-01-01T00:00:00Z'),
      }),
    ];
    // Default createdAt is 2025-01-01: pc (older createdAt) beats pb/pd at
    // sortOrder 1; pb vs pd tie on both and fall to name; pa's sortOrder loses.
    const names = computePortfolioGroups(rows, QUOTES, FX).map((g) => g.portfolioName);
    expect(names).toEqual(['Beta', 'Aardvark', 'Alpha', 'Zeta']);
  });

  it('a fully-sold portfolio keeps its group: zero shares, dashes, never a fake valued zero', () => {
    const rows = [
      row({ quantity: '10', tradeDate: '2026-01-05' }),
      row({ side: 'sell', quantity: '10', price: '120', tradeDate: '2026-02-05' }),
      inIkze({ quantity: '5' }),
    ];
    const groups = computePortfolioGroups(rows, QUOTES, FX);

    expect(groups).toHaveLength(2);
    const sold = groups[0].summary;
    expect(sold.quantity).toBe(fmtQuantity(dec('0')));
    expect(sold.avgCost).toBeNull();
    expect(sold.costBasisPLN).toBe(fmtMoney(dec('0'), 'PLN'));
    expect(sold.valuePLN).toBeNull();
    expect(sold.unrealizedPLN).toBeNull();
    expect(sold.unrealizedPct).toBe('—');
    expect(sold.direction).toBe('neutral');
    expect(sold.oversold).toBe(false);
  });

  it('flags the oversold portfolio alone; the healthy one is untouched', () => {
    const rows = [row({ side: 'sell', quantity: '5' }), inIkze({ quantity: '5' })];
    const groups = computePortfolioGroups(rows, QUOTES, FX);

    expect(groups[0].summary.oversold).toBe(true);
    expect(groups[1].summary.oversold).toBe(false);
  });

  it('no quote: value and unrealized go null (rendered "—"), cost figures survive', () => {
    const groups = computePortfolioGroups([row()], new Map(), FX);
    const s = groups[0].summary;

    expect(s.valuePLN).toBeNull();
    expect(s.unrealizedPLN).toBeNull();
    expect(s.unrealizedPct).toBe('—');
    expect(s.direction).toBe('neutral');
    expect(s.quantity).toBe(fmtQuantity(dec('10')));
    expect(s.avgCost).toBe(fmtMoney(dec('100'), 'USD'));
    expect(s.costBasisPLN).toBe(fmtMoney(dec('4000'), 'PLN'));
  });

  it('quote present but FX missing (non-PLN): value and unrealized go null', () => {
    const groups = computePortfolioGroups([row()], QUOTES, new Map());
    const s = groups[0].summary;

    expect(s.valuePLN).toBeNull();
    expect(s.unrealizedPLN).toBeNull();
    expect(s.unrealizedPct).toBe('—');
    expect(s.costBasisPLN).toBe(fmtMoney(dec('4000'), 'PLN'));
  });

  it('a wrong-currency quote is treated as no quote at all', () => {
    const groups = computePortfolioGroups([row()], new Map([['AAPL', quote({ currency: 'PLN' })]]), FX);
    expect(groups[0].summary.valuePLN).toBeNull();
    expect(groups[0].summary.unrealizedPLN).toBeNull();
  });

  it('PLN instrument: the rate short-circuits to 1 — value without any fxRates entry', () => {
    const rows = [
      row({ symbol: 'PKO', displayName: 'PKO BP', currency: 'PLN', fxRateToBase: '1' }),
    ];
    const groups = computePortfolioGroups(
      rows,
      new Map([['PKO', quote({ price: '110', currency: 'PLN' })]]),
      new Map(),
    );
    const s = groups[0].summary;

    // 10 × 110 × 1 = 1100 PLN; basis 1000 → +100.
    expect(s.valuePLN).toBe(fmtMoney(dec('1100'), 'PLN'));
    expect(s.unrealizedPLN).toBe(`+${fmtMoney(dec('100'), 'PLN')}`);
  });

  it('a single portfolio yields exactly one group — the page owns the render branch', () => {
    const groups = computePortfolioGroups([row(), row({ quantity: '3' })], QUOTES, FX);
    expect(groups).toHaveLength(1);
    expect(groups[0].summary.quantity).toBe(fmtQuantity(dec('13')));
  });

  it('interleaved sell: input order is irrelevant — the engine sorts internally', () => {
    const sorted = [
      row({ quantity: '10', price: '100', tradeDate: '2026-01-05' }),
      row({ side: 'sell', quantity: '5', price: '150', tradeDate: '2026-02-05' }),
      row({ quantity: '10', price: '200', tradeDate: '2026-03-05' }),
    ];
    const shuffled = [sorted[2], sorted[0], sorted[1]];

    const a = computePortfolioGroups(sorted, QUOTES, FX);
    const b = computePortfolioGroups(shuffled, QUOTES, FX);
    expect(a).toEqual(b);

    // And the figures are the order-dependent average-cost answer: after the
    // sell, basis 500; +2000 buy → basis 2500 over 15 shares.
    expect(a[0].summary.quantity).toBe(fmtQuantity(dec('15')));
    expect(a[0].summary.avgCost).toBe(fmtMoney(dec('2500').dividedBy(dec('15')), 'USD'));
  });
});
