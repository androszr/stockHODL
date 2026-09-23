import { describe, expect, it } from 'vitest';

import { dec } from './money';
import {
  computePositions,
  displayablePositions,
  quantityHeldBefore,
  type EngineTransaction,
  type QuoteInput,
} from './position-engine';

/**
 * Table-driven suite for the position engine — the single most important test
 * surface in the app. Every expected value here is hand-verifiable.
 *
 * Assertions go through `.equals(dec(...))` / `.toFixed(n)` only; `toNumber()`
 * would reintroduce the float drift the engine exists to avoid.
 */

let seq = 0;

function tx(overrides: Partial<EngineTransaction> = {}): EngineTransaction {
  seq += 1;
  return {
    id: `tx-${String(seq).padStart(4, '0')}`,
    instrumentId: 'inst-1',
    symbol: 'CDR.WA',
    displayName: 'CD Projekt',
    currency: 'PLN',
    side: 'buy',
    quantity: '1',
    price: '100',
    fees: '0',
    fxRateToBase: '1',
    tradeDate: '2026-01-01',
    createdAt: new Date('2026-01-01T10:00:00Z'),
    ...overrides,
  };
}

describe('computePositions', () => {
  it('returns [] for empty input', () => {
    expect(computePositions([])).toEqual([]);
  });

  it('includes fees in the cost basis of a single buy (§9 Q5)', () => {
    const [p] = computePositions([tx({ quantity: '10', price: '300', fees: '5' })]);
    expect(p.quantity.equals(dec('10'))).toBe(true);
    expect(p.costBasis.equals(dec('3005'))).toBe(true);
    expect(p.avgCost!.equals(dec('300.5'))).toBe(true);
    expect(p.realizedPLN.isZero()).toBe(true);
    expect(p.oversold).toBe(false);
  });

  it('averages two buys: 10 @ 300 + fee 5, 10 @ 400 + fee 5 -> avg 350.5', () => {
    const [p] = computePositions([
      tx({ quantity: '10', price: '300', fees: '5', tradeDate: '2026-01-01' }),
      tx({ quantity: '10', price: '400', fees: '5', tradeDate: '2026-01-02' }),
    ]);
    expect(p.quantity.equals(dec('20'))).toBe(true);
    expect(p.costBasis.equals(dec('7010'))).toBe(true);
    expect(p.avgCost!.equals(dec('350.5'))).toBe(true);
    expect(p.costBasisPLN.equals(dec('7010'))).toBe(true);
  });

  it('partial sell leaves avg cost unchanged and realizes gain against it', () => {
    const [p] = computePositions([
      tx({ quantity: '10', price: '100', tradeDate: '2026-01-01' }),
      tx({ side: 'sell', quantity: '4', price: '150', tradeDate: '2026-01-02' }),
    ]);
    expect(p.quantity.equals(dec('6'))).toBe(true);
    expect(p.avgCost!.equals(dec('100'))).toBe(true);
    expect(p.costBasis.equals(dec('600'))).toBe(true);
    // proceeds 4*150 = 600 minus basis 4*100 = 400 -> +200
    expect(p.realizedPLN.equals(dec('200'))).toBe(true);
  });

  it('realizes a loss when selling below avg cost', () => {
    const [p] = computePositions([
      tx({ quantity: '10', price: '100', tradeDate: '2026-01-01' }),
      tx({ side: 'sell', quantity: '5', price: '80', tradeDate: '2026-01-02' }),
    ]);
    // proceeds 400 minus basis 500 -> -100
    expect(p.realizedPLN.equals(dec('-100'))).toBe(true);
    expect(p.quantity.equals(dec('5'))).toBe(true);
    expect(p.costBasis.equals(dec('500'))).toBe(true);
  });

  it('handles interleaved buy -> sell -> buy order-dependently', () => {
    const [p] = computePositions([
      tx({ quantity: '10', price: '100', tradeDate: '2026-01-01' }),
      tx({ side: 'sell', quantity: '5', price: '120', tradeDate: '2026-01-02' }),
      tx({ quantity: '5', price: '200', tradeDate: '2026-01-03' }),
    ]);
    // After sell: qty 5, basis 500. After buy: qty 10, basis 1500 -> avg 150.
    expect(p.quantity.equals(dec('10'))).toBe(true);
    expect(p.costBasis.equals(dec('1500'))).toBe(true);
    expect(p.avgCost!.equals(dec('150'))).toBe(true);
    expect(p.realizedPLN.equals(dec('100'))).toBe(true);
  });

  it('zeroes basis exactly on full exit and starts a fresh average on re-entry', () => {
    const [p] = computePositions([
      tx({ quantity: '10', price: '100', tradeDate: '2026-01-01' }),
      tx({ side: 'sell', quantity: '10', price: '110', tradeDate: '2026-01-02' }),
      tx({ quantity: '5', price: '200', tradeDate: '2026-01-03' }),
    ]);
    expect(p.quantity.equals(dec('5'))).toBe(true);
    expect(p.avgCost!.equals(dec('200'))).toBe(true);
    expect(p.costBasis.equals(dec('1000'))).toBe(true);
    expect(p.realizedPLN.equals(dec('100'))).toBe(true);
  });

  it('returns a closed position (qty 0, avgCost null) carrying realizedPLN', () => {
    const positions = computePositions([
      tx({ quantity: '10', price: '100', tradeDate: '2026-01-01' }),
      tx({ side: 'sell', quantity: '10', price: '110', tradeDate: '2026-01-02' }),
    ]);
    expect(positions).toHaveLength(1);
    const [p] = positions;
    expect(p.quantity.isZero()).toBe(true);
    expect(p.avgCost).toBeNull();
    expect(p.costBasis.isZero()).toBe(true);
    expect(p.costBasisPLN.isZero()).toBe(true);
    expect(p.realizedPLN.equals(dec('100'))).toBe(true);
  });

  it('clamps an oversell to held quantity and flags it (§9 Q4)', () => {
    const [p] = computePositions([
      tx({ quantity: '5', price: '100', tradeDate: '2026-01-01' }),
      tx({ side: 'sell', quantity: '10', price: '120', tradeDate: '2026-01-02' }),
    ]);
    expect(p.oversold).toBe(true);
    expect(p.quantity.isZero()).toBe(true);
    // Realized on the 5 actually held: 5*120 - 5*100 = 100. The phantom 5 never
    // enters the arithmetic.
    expect(p.realizedPLN.equals(dec('100'))).toBe(true);
    expect(p.costBasis.isZero()).toBe(true);
  });

  it('flags a sell with nothing held and charges only the fee', () => {
    const [p] = computePositions([
      tx({ side: 'sell', quantity: '5', price: '100', fees: '2', tradeDate: '2026-01-01' }),
    ]);
    expect(p.oversold).toBe(true);
    expect(p.quantity.isZero()).toBe(true);
    expect(p.realizedPLN.equals(dec('-2'))).toBe(true);
  });

  it('reduces sell proceeds by fees', () => {
    const [p] = computePositions([
      tx({ quantity: '10', price: '100', tradeDate: '2026-01-01' }),
      tx({ side: 'sell', quantity: '5', price: '120', fees: '10', tradeDate: '2026-01-02' }),
    ]);
    // (5*120 - 10) - 5*100 = 90
    expect(p.realizedPLN.equals(dec('90'))).toBe(true);
  });

  it('converts a USD lot to PLN at the stored trade-date rate', () => {
    const [p] = computePositions([
      tx({
        symbol: 'AAPL',
        currency: 'USD',
        quantity: '10',
        price: '50',
        fees: '0',
        fxRateToBase: '4.05',
      }),
    ]);
    expect(p.costBasis.equals(dec('500'))).toBe(true);
    expect(p.costBasisPLN.equals(dec('2025'))).toBe(true);
  });

  it('realizes P/L in PLN using each leg\'s own stored fx rate', () => {
    // Buy at 4.00, sell at 4.20 — both legs must use their own trade-date
    // rate, never one shared rate. Pinned so the NBP auto-fetch (or any later
    // FX refactor) cannot regress it silently.
    const [p] = computePositions([
      tx({
        symbol: 'AAPL',
        currency: 'USD',
        quantity: '10',
        price: '50',
        fxRateToBase: '4.00',
        tradeDate: '2026-01-01',
      }),
      tx({
        symbol: 'AAPL',
        currency: 'USD',
        side: 'sell',
        quantity: '5',
        price: '60',
        fxRateToBase: '4.20',
        tradeDate: '2026-01-02',
      }),
    ]);
    // proceeds 5*60*4.20 = 1260; PLN basis released 5 * (2000/10) = 1000 -> +260
    expect(p.realizedPLN.equals(dec('260'))).toBe(true);
    expect(p.quantity.equals(dec('5'))).toBe(true);
    expect(p.costBasis.equals(dec('250'))).toBe(true);
    expect(p.costBasisPLN.equals(dec('1000'))).toBe(true);
  });

  it('keeps costBasisPLN identical to costBasis for a PLN lot at fx 1', () => {
    const [p] = computePositions([
      tx({ quantity: '3', price: '111.11', fees: '1.5', fxRateToBase: '1' }),
    ]);
    expect(p.costBasisPLN.equals(p.costBasis)).toBe(true);
    expect(p.costBasis.equals(dec('334.83'))).toBe(true);
  });

  it('keeps two instruments fully independent', () => {
    const positions = computePositions([
      tx({ instrumentId: 'inst-1', symbol: 'CDR.WA', quantity: '10', price: '300' }),
      tx({ instrumentId: 'inst-2', symbol: 'AAPL', currency: 'USD', quantity: '2', price: '50', fxRateToBase: '4' }),
    ]);
    expect(positions).toHaveLength(2);
    const aapl = positions.find((p) => p.symbol === 'AAPL')!;
    const cdr = positions.find((p) => p.symbol === 'CDR.WA')!;
    expect(aapl.costBasisPLN.equals(dec('400'))).toBe(true);
    expect(cdr.costBasisPLN.equals(dec('3000'))).toBe(true);
  });

  it('sorts by trade date internally: unsorted input computes correctly', () => {
    // Insertion order is sell-first; trade order is buy-first. A naive
    // insertion-order pass would flag an oversell here.
    const [p] = computePositions([
      tx({ side: 'sell', quantity: '5', price: '150', tradeDate: '2026-02-01' }),
      tx({ quantity: '10', price: '100', tradeDate: '2026-01-01' }),
    ]);
    expect(p.oversold).toBe(false);
    expect(p.quantity.equals(dec('5'))).toBe(true);
    expect(p.realizedPLN.equals(dec('250'))).toBe(true);
  });

  it('breaks same-day ties by createdAt', () => {
    // Same tradeDate; the buy was entered first. Listed sell-first on purpose.
    const [p] = computePositions([
      tx({
        side: 'sell',
        quantity: '5',
        price: '120',
        tradeDate: '2026-01-01',
        createdAt: new Date('2026-01-01T11:00:00Z'),
      }),
      tx({
        quantity: '10',
        price: '100',
        tradeDate: '2026-01-01',
        createdAt: new Date('2026-01-01T10:00:00Z'),
      }),
    ]);
    expect(p.oversold).toBe(false);
    expect(p.quantity.equals(dec('5'))).toBe(true);
    expect(p.realizedPLN.equals(dec('100'))).toBe(true);
  });

  it('survives a precision case where float math would drift', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floats.
    const [p] = computePositions([
      tx({ quantity: '0.1', price: '3', tradeDate: '2026-01-01' }),
      tx({ quantity: '0.2', price: '3', tradeDate: '2026-01-02' }),
    ]);
    expect(p.quantity.equals(dec('0.3'))).toBe(true);
    expect(p.costBasis.equals(dec('0.9'))).toBe(true);
    expect(p.avgCost!.equals(dec('3'))).toBe(true);
  });

  it('leaves marketValue and unrealizedPLN null when no quote is supplied (M2)', () => {
    const [p] = computePositions([tx({ quantity: '10', price: '300' })]);
    expect(p.marketValue).toBeNull();
    expect(p.unrealizedPLN).toBeNull();
  });

  it('keeps oversold zero-quantity positions displayable, hides clean closes', () => {
    // The classic manual-entry mistake — a sell entered without its buy —
    // clamps quantity to 0 AND sets oversold. Filtering on quantity alone
    // would hide the one row the warning badge exists for.
    const positions = computePositions([
      // open position
      tx({ instrumentId: 'inst-1', symbol: 'AAA', quantity: '10', price: '100' }),
      // cleanly closed position — hidden from Holdings
      tx({ instrumentId: 'inst-2', symbol: 'BBB', quantity: '5', price: '100', tradeDate: '2026-01-01' }),
      tx({ instrumentId: 'inst-2', symbol: 'BBB', side: 'sell', quantity: '5', price: '110', tradeDate: '2026-01-02' }),
      // sell with no buy — qty 0 but oversold, must stay visible
      tx({ instrumentId: 'inst-3', symbol: 'CCC', side: 'sell', quantity: '3', price: '50' }),
    ]);

    const shown = displayablePositions(positions);
    expect(shown.map((p) => p.symbol)).toEqual(['AAA', 'CCC']);
    const ccc = shown.find((p) => p.symbol === 'CCC')!;
    expect(ccc.quantity.isZero()).toBe(true);
    expect(ccc.oversold).toBe(true);
  });

  it('computes marketValue and unrealizedPLN when a quote and rate exist (M3 hook)', () => {
    const quotes = new Map<string, QuoteInput>([
      ['AAPL', { price: '60', currency: 'USD' }],
    ]);
    const fx = new Map<string, string>([['USD', '4']]);
    const [p] = computePositions(
      [tx({ symbol: 'AAPL', currency: 'USD', quantity: '10', price: '50', fxRateToBase: '4' })],
      quotes,
      fx,
    );
    expect(p.marketValue!.equals(dec('600'))).toBe(true);
    // 600 * 4 - 2000 = 400
    expect(p.unrealizedPLN!.equals(dec('400'))).toBe(true);
  });

  it('computes unrealized PLN through fees and per-leg fx rates', () => {
    // Two USD buys with fees, each frozen at its own trade-date rate. The
    // valuation rate (4.10) applies only to the market side — never to basis.
    const quotes = new Map<string, QuoteInput>([
      ['AAPL', { price: '70', currency: 'USD' }],
    ]);
    const fx = new Map<string, string>([['USD', '4.10']]);
    const [p] = computePositions(
      [
        tx({
          symbol: 'AAPL',
          currency: 'USD',
          quantity: '10',
          price: '50',
          fees: '5',
          fxRateToBase: '4.00',
          tradeDate: '2026-01-01',
        }),
        tx({
          symbol: 'AAPL',
          currency: 'USD',
          quantity: '10',
          price: '60',
          fees: '5',
          fxRateToBase: '4.20',
          tradeDate: '2026-01-02',
        }),
      ],
      quotes,
      fx,
    );
    // Basis: (10*50+5)*4.00 + (10*60+5)*4.20 = 2020 + 2541 = 4561 PLN.
    expect(p.costBasisPLN.equals(dec('4561'))).toBe(true);
    expect(p.marketValue!.equals(dec('1400'))).toBe(true);
    // 20 * 70 * 4.10 - 4561 = 5740 - 4561 = 1179.
    expect(p.unrealizedPLN!.equals(dec('1179'))).toBe(true);
  });

  it('values a PLN instrument without an fxRates entry', () => {
    // PLN short-circuits to rate 1 inside the engine — the fxRates map is
    // never consulted, so an empty map must not block valuation.
    const quotes = new Map<string, QuoteInput>([
      ['CDR.WA', { price: '110', currency: 'PLN' }],
    ]);
    const [p] = computePositions(
      [tx({ quantity: '10', price: '100' })],
      quotes,
      new Map<string, string>(),
    );
    expect(p.marketValue!.equals(dec('1100'))).toBe(true);
    expect(p.unrealizedPLN!.equals(dec('100'))).toBe(true);
  });

  it('leaves unrealizedPLN null when the quote currency has no rate', () => {
    // Quote present, FX lookup failed: the native market value is knowable,
    // the PLN gain/loss is not — and must read "—", never a guess.
    const quotes = new Map<string, QuoteInput>([
      ['AAPL', { price: '60', currency: 'USD' }],
    ]);
    const [p] = computePositions(
      [tx({ symbol: 'AAPL', currency: 'USD', quantity: '10', price: '50', fxRateToBase: '4' })],
      quotes,
      new Map<string, string>(),
    );
    expect(p.marketValue!.equals(dec('600'))).toBe(true);
    expect(p.unrealizedPLN).toBeNull();
  });

  it('ignores a quote whose currency mismatches the instrument', () => {
    // A USD-priced quote against an EUR instrument would be multiplied by the
    // wrong FX rate — the guard must drop it entirely, even with both rates
    // sitting right there in the map.
    const quotes = new Map<string, QuoteInput>([
      ['SAP', { price: '200', currency: 'USD' }],
    ]);
    const fx = new Map<string, string>([
      ['EUR', '4.30'],
      ['USD', '4.10'],
    ]);
    const [p] = computePositions(
      [tx({ symbol: 'SAP', currency: 'EUR', quantity: '10', price: '150', fxRateToBase: '4.25' })],
      quotes,
      fx,
    );
    expect(p.marketValue).toBeNull();
    expect(p.unrealizedPLN).toBeNull();
  });

  it('keeps marketValue null for an oversold zero-quantity position', () => {
    // Clamped-to-zero oversell: nothing is held, so there is nothing to value
    // — a quote must not resurrect a market value for a phantom position.
    const quotes = new Map<string, QuoteInput>([
      ['AAPL', { price: '60', currency: 'USD' }],
    ]);
    const fx = new Map<string, string>([['USD', '4']]);
    const [p] = computePositions(
      [
        tx({ symbol: 'AAPL', currency: 'USD', quantity: '5', price: '50', fxRateToBase: '4', tradeDate: '2026-01-01' }),
        tx({ symbol: 'AAPL', currency: 'USD', side: 'sell', quantity: '10', price: '55', fxRateToBase: '4', tradeDate: '2026-01-02' }),
      ],
      quotes,
      fx,
    );
    expect(p.oversold).toBe(true);
    expect(p.quantity.isZero()).toBe(true);
    expect(p.marketValue).toBeNull();
    expect(p.unrealizedPLN).toBeNull();
  });
});

describe('quantityHeldBefore — dividend eligibility boundary', () => {
  // Eligibility is quantity held at the END of the day BEFORE the ex-date:
  // strict `tradeDate < dateISO`. The three boundary cases are named — an
  // off-by-one here pays dividends on shares bought on the ex-date.

  it('counts a buy strictly before the date', () => {
    const held = quantityHeldBefore([tx({ quantity: '10', tradeDate: '2026-08-12' })], '2026-08-13');
    expect(held.equals(dec('10'))).toBe(true);
  });

  it('excludes a buy ON the date — the named boundary case', () => {
    const held = quantityHeldBefore([tx({ quantity: '10', tradeDate: '2026-08-13' })], '2026-08-13');
    expect(held.isZero()).toBe(true);
  });

  it('excludes a buy after the date', () => {
    const held = quantityHeldBefore([tx({ quantity: '10', tradeDate: '2026-08-14' })], '2026-08-13');
    expect(held.isZero()).toBe(true);
  });

  it('returns zero for an empty ledger', () => {
    expect(quantityHeldBefore([], '2026-08-13').isZero()).toBe(true);
  });

  it('accumulates multiple buys and nets interleaved sells', () => {
    const held = quantityHeldBefore(
      [
        tx({ quantity: '10', tradeDate: '2026-01-05' }),
        tx({ side: 'sell', quantity: '4', tradeDate: '2026-02-01' }),
        tx({ quantity: '2.5', tradeDate: '2026-03-01' }),
        // On/after the boundary: never counted.
        tx({ quantity: '100', tradeDate: '2026-08-13' }),
        tx({ side: 'sell', quantity: '1', tradeDate: '2026-09-01' }),
      ],
      '2026-08-13',
    );
    expect(held.equals(dec('8.5'))).toBe(true);
  });

  it('clamps an oversell to zero — parity with the engine walk', () => {
    const rows = [
      tx({ quantity: '5', tradeDate: '2026-01-05' }),
      tx({ side: 'sell', quantity: '10', tradeDate: '2026-02-01' }),
      tx({ quantity: '3', tradeDate: '2026-03-01' }),
    ];
    const held = quantityHeldBefore(rows, '2026-08-13');
    // Never negative: the clamped sell leaves 0, the later buy adds 3 — the
    // same terminal quantity computePositions reports over the same rows.
    expect(held.equals(dec('3'))).toBe(true);
    const [p] = computePositions(rows);
    expect(p.quantity.equals(held)).toBe(true);
  });

  it('honours the sell-before-its-buy ordering through compareTx (same-day createdAt tiebreak)', () => {
    // Same trade date: createdAt decides — the sell entered first clamps to
    // zero, then the buy lands. Order in the input array must not matter.
    const sell = tx({
      side: 'sell',
      quantity: '5',
      tradeDate: '2026-01-05',
      createdAt: new Date('2026-01-05T09:00:00Z'),
    });
    const buy = tx({
      quantity: '5',
      tradeDate: '2026-01-05',
      createdAt: new Date('2026-01-05T10:00:00Z'),
    });
    expect(quantityHeldBefore([buy, sell], '2026-02-01').equals(dec('5'))).toBe(true);
    expect(quantityHeldBefore([sell, buy], '2026-02-01').equals(dec('5'))).toBe(true);
  });
});
