import { describe, expect, it } from 'vitest';

import { computePositions } from '@/lib/position-engine';

import { computeDayReportFigures, liveFigures, usdPlnMove } from './figures';

const tx = (id: string, symbol: string, quantity: string) => ({
  id, instrumentId: id, symbol, displayName: symbol, currency: 'USD', side: 'buy' as const,
  quantity, price: '10', fees: '0', fxRateToBase: '4', tradeDate: '2026-09-01', createdAt: new Date(0),
});
const positions = computePositions([tx('a', 'AAA', '2'), tx('b', 'BBB', '1')]);

describe('day report figures', () => {
  it('computes contribution in PLN', () => expect(computeDayReportFigures({ positions, closeByInstrument: new Map([['a', '12'], ['b', '20']]), prevCloseByInstrument: new Map([['a', '10'], ['b', '19']]), fxByCurrency: new Map([['USD', '4']]) }).dayChangePLN?.toString()).toBe('20'));
  it('sorts absolute movers', () => expect(computeDayReportFigures({ positions, closeByInstrument: new Map([['a', '12'], ['b', '30']]), prevCloseByInstrument: new Map([['a', '10'], ['b', '20']]), fxByCurrency: new Map([['USD', '4']]) }).contributions[0].symbol).toBe('BBB'));
  it('names a missing close as partial', () => expect(computeDayReportFigures({ positions, closeByInstrument: new Map([['a', '12']]), prevCloseByInstrument: new Map([['a', '10'], ['b', '20']]), fxByCurrency: new Map([['USD', '4']]) }).partialSymbols).toEqual(['BBB']));
  it('excludes unsupported currencies', () => {
    const foreign = [{ ...positions[0], currency: 'EUR' }];
    expect(computeDayReportFigures({ positions: foreign, closeByInstrument: new Map(), prevCloseByInstrument: new Map(), fxByCurrency: new Map() }).excludedSymbols).toEqual(['AAA']);
  });
  it('returns null pct on a zero basis', () => expect(computeDayReportFigures({ positions: computePositions([tx('z', 'ZERO', '1')]), closeByInstrument: new Map([['z', '1']]), prevCloseByInstrument: new Map([['z', '0']]), fxByCurrency: new Map([['USD', '4']]) }).dayChangePct).toBeNull());
  it('live totals equal the shared summary path', () => {
    const quote = { price: '12', currency: 'USD', prevClose: '10', dayChangeAmt: '2', dayChangePct: '20', extendedChangePct: null, extendedKind: null, extendedEndedAtMs: null, extendedLive: false };
    expect(liveFigures([positions[0]], new Map([['AAA', quote]]), new Map([['USD', '4']])).dayChangePLN?.toString()).toBe('16');
  });
  it('skips duplicate carried FX rates', () => expect(usdPlnMove(new Map([['2026-09-02', '4'], ['2026-09-03', '4'], ['2026-09-04', '4.2']]), '2026-09-04')?.pct?.toString()).toBe('5'));
});
