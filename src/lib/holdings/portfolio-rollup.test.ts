import { describe, expect, it } from 'vitest';

import { dec, fmtMoney } from '@/lib/money';
import type { EngineTransaction } from '@/lib/position-engine';

import type { HoldingQuote } from './live-payload';
import { composePortfolioRollup } from './portfolio-rollup';

/**
 * The rollup contract: same engine → summary pipeline as Holdings, run once
 * per portfolio group; exclusion (named, never zeroed) and the '—'-over-fake-
 * zero rules must hold per bar and per panel row.
 */

function tx(overrides: Partial<EngineTransaction> = {}): EngineTransaction {
  return {
    id: 't1',
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
    ...overrides,
  };
}

function quote(overrides: Partial<HoldingQuote> = {}): HoldingQuote {
  return {
    price: '110',
    currency: 'USD',
    prevClose: '105',
    dayChangeAmt: '5',
    dayChangePct: null,
    extendedChangePct: null,
    extendedKind: null,
    extendedEndedAtMs: null,
    extendedLive: false,
    ...overrides,
  };
}

const FX = new Map([['USD', '4.00']]);
const QUOTES = new Map([['AAPL', quote()]]);

describe('composePortfolioRollup', () => {
  it('prices a USD position: value = qty × price × fx, formatted PLN', () => {
    const r = composePortfolioRollup([tx()], QUOTES, FX);

    // 10 × 110 × 4 = 4400 PLN; basis 10 × 100 × 4 = 4000 → +10.00%.
    expect(r.tickers).toHaveLength(1);
    expect(r.tickers[0].valuePLN).toBe(fmtMoney(dec('4400'), 'PLN'));
    expect(r.valuePLN).toBe(fmtMoney(dec('4400'), 'PLN'));
    expect(r.excludedSymbols).toEqual([]);
  });

  it('rolls up two portfolio groups independently for the same instrument', () => {
    const a = composePortfolioRollup([tx()], QUOTES, FX);
    const b = composePortfolioRollup([tx({ id: 't2', quantity: '2' })], QUOTES, FX);

    expect(a.valuePLN).toBe(fmtMoney(dec('4400'), 'PLN'));
    expect(b.valuePLN).toBe(fmtMoney(dec('880'), 'PLN')); // 2 × 110 × 4
    expect(a.tickers[0].quantity).not.toBe(b.tickers[0].quantity);
  });

  it('short-circuits FX to 1 for a PLN instrument, no rate lookup needed', () => {
    const txs = [tx({ symbol: 'PKO', displayName: 'PKO BP', currency: 'PLN', fxRateToBase: '1' })];
    const quotes = new Map([['PKO', quote({ currency: 'PLN' })]]);

    const r = composePortfolioRollup(txs, quotes, new Map());
    expect(r.tickers[0].valuePLN).toBe(fmtMoney(dec('1100'), 'PLN')); // 10 × 110 × 1
    expect(r.excludedSymbols).toEqual([]);
  });

  it('excludes and names a wrong-currency quote; the bar total omits it', () => {
    const txs = [tx(), tx({ id: 't2', instrumentId: 'i2', symbol: 'MSFT', displayName: 'Microsoft' })];
    const quotes = new Map([
      ['AAPL', quote()],
      ['MSFT', quote({ currency: 'PLN' })], // wrong currency for a USD instrument
    ]);

    const r = composePortfolioRollup(txs, quotes, FX);
    expect(r.excludedSymbols).toEqual(['MSFT']);
    expect(r.valuePLN).toBe(fmtMoney(dec('4400'), 'PLN')); // AAPL only, never zeroed
    const msft = r.tickers.find((t) => t.symbol === 'MSFT')!;
    expect(msft.valuePLN).toBeNull();
    expect(msft.changePct).toBe('—');
    expect(msft.direction).toBe('neutral');
  });

  it('excludes and names a position whose FX rate is missing', () => {
    const r = composePortfolioRollup([tx()], QUOTES, new Map());

    expect(r.excludedSymbols).toEqual(['AAPL']);
    expect(r.valuePLN).toBeNull(); // nothing priced — null, not a fake 0,00 zł
    expect(r.tickers[0].valuePLN).toBeNull();
  });

  it('returns null value and null changePct when nothing is priced', () => {
    const r = composePortfolioRollup([tx()], new Map(), FX);

    expect(r.valuePLN).toBeNull();
    expect(r.changePct).toBeNull();
    expect(r.excludedSymbols).toEqual(['AAPL']);
  });

  it('renders "—" for a zero-cost-basis ticker, never +0.00%', () => {
    // A free share: quantity in, zero cost. pctChange on a zero basis is null.
    const r = composePortfolioRollup([tx({ price: '0', fees: '0' })], QUOTES, FX);

    expect(r.tickers[0].changePct).toBe('—');
    expect(r.tickers[0].valuePLN).toBe(fmtMoney(dec('4400'), 'PLN'));
  });

  it('keeps an oversold-at-zero row in tickers with a null value, NOT in excludedSymbols', () => {
    // Sell entered before its buy: clamped to zero quantity, flagged oversold.
    const r = composePortfolioRollup([tx({ side: 'sell' })], QUOTES, FX);

    expect(r.tickers).toHaveLength(1);
    expect(r.tickers[0].oversold).toBe(true);
    expect(r.tickers[0].valuePLN).toBeNull();
    expect(r.excludedSymbols).toEqual([]); // holds nothing — not "not priced"
  });

  it('marks a gain with direction "gain" and a "+"-signed percent', () => {
    const r = composePortfolioRollup([tx()], QUOTES, FX); // 4400 vs 4000 basis

    expect(r.tickers[0].direction).toBe('gain');
    expect(r.tickers[0].changePct.startsWith('+')).toBe(true);
    expect(r.changePct?.direction).toBe('gain');
    expect(r.changePct?.text.startsWith('+')).toBe(true);
  });

  it('marks a loss with direction "loss" and a "-"-signed percent', () => {
    const quotes = new Map([['AAPL', quote({ price: '90' })]]); // 3600 vs 4000 basis
    const r = composePortfolioRollup([tx()], quotes, FX);

    expect(r.tickers[0].direction).toBe('loss');
    expect(r.tickers[0].changePct.startsWith('-')).toBe(true);
    expect(r.changePct?.direction).toBe('loss');
    expect(r.changePct?.text.startsWith('-')).toBe(true);
  });

  it('marks an exactly-flat position neutral with an unsigned percent', () => {
    const quotes = new Map([['AAPL', quote({ price: '100' })]]); // 4000 vs 4000 basis
    const r = composePortfolioRollup([tx()], quotes, FX);

    expect(r.tickers[0].direction).toBe('neutral');
    expect(r.tickers[0].changePct.startsWith('+')).toBe(false);
    expect(r.tickers[0].changePct.startsWith('-')).toBe(false);
    expect(r.changePct?.direction).toBe('neutral');
  });

  it('returns an empty rollup for an empty portfolio group', () => {
    const r = composePortfolioRollup([], QUOTES, FX);

    expect(r.tickers).toEqual([]);
    expect(r.valuePLN).toBeNull();
    expect(r.changePct).toBeNull();
    expect(r.excludedSymbols).toEqual([]);
  });
});
