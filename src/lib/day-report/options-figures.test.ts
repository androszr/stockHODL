import { describe, expect, it } from 'vitest';

import { dec } from '@/lib/money';
import type { OptionLotContribution, OptionPositionRow } from '@/lib/options/options-payload';

import { activeOptionLots, combineDayFigures, computeOptionsDayFigures, liveOptionsDayFigures } from './options-figures';

const lot = (overrides: Partial<OptionPositionRow> = {}): OptionPositionRow => ({
  id: 'lot', ticker: 'O:NIMB270319C00052500', underlying: 'NIMB', contractType: 'call',
  strikePrice: '52.5', expirationDate: '2027-03-19', sharesPerContract: '100', quantity: '1',
  entryPrice: '2', tradeDate: '2026-09-01', fees: '0', ...overrides,
});
const valuations = new Map([['O:NIMB270319C00052500|2026-09-03', '2'], ['O:NIMB270319C00052500|2026-09-04', '3']]);

describe('option day figures', () => {
  it('includes lots active on D', () => expect(activeOptionLots([lot()], '2026-09-04')).toHaveLength(1));
  it('excludes lots bought after D', () => expect(activeOptionLots([lot({ tradeDate: '2026-09-05' })], '2026-09-04')).toHaveLength(0));
  it('excludes lots expired before D', () => expect(activeOptionLots([lot({ expirationDate: '2026-09-03' })], '2026-09-04')).toHaveLength(0));
  it('includes a lot expiring on D', () => expect(activeOptionLots([lot({ expirationDate: '2026-09-04' })], '2026-09-04')).toHaveLength(1));
  it('computes USD and PLN changes', () => {
    const result = computeOptionsDayFigures({ lots: [lot()], valuationsByTickerDate: valuations, prevSession: '2026-09-03', dayISO: '2026-09-04', fxUsd: '4' });
    expect(result.dayChangeUSD?.toString()).toBe('100');
    expect(result.dayChangePLN?.toString()).toBe('400');
  });
  it('names a missing pair and marks partial', () => {
    const result = computeOptionsDayFigures({ lots: [lot()], valuationsByTickerDate: new Map([['O:NIMB270319C00052500|2026-09-04', '3']]), prevSession: '2026-09-03', dayISO: '2026-09-04', fxUsd: '4' });
    expect(result.partial).toBe(true);
    expect(result.excludedLabels[0]).toContain('Mar27');
  });
  it('groups two lots of one contract', () => expect(computeOptionsDayFigures({ lots: [lot(), lot({ id: 'two', quantity: '2' })], valuationsByTickerDate: valuations, prevSession: '2026-09-03', dayISO: '2026-09-04', fxUsd: '4' }).groups).toHaveLength(1));
  it('live sums the shared contribution amounts', () => {
    const c: OptionLotContribution = { ticker: 'T', groupKey: 'T', expirationDate: '2027-01-01', expired: false, label: 'T', valueDec: dec('300'), basisDec: dec('200'), plDec: dec('100'), dayAmtDec: dec('50'), dayBaseValueDec: dec('250'), priceIsEstimate: true, staleNote: null };
    expect(liveOptionsDayFigures([c], '4').dayChangePLN?.toString()).toBe('200');
  });
  it('combines holding and option values', () => {
    const holdings = { contributions: [], dayChangePLN: dec('10'), dayChangePct: null, valueAtClosePLN: dec('100'), partialSymbols: [], excludedSymbols: [] };
    const options = computeOptionsDayFigures({ lots: [lot()], valuationsByTickerDate: valuations, prevSession: '2026-09-03', dayISO: '2026-09-04', fxUsd: '4' });
    expect(combineDayFigures(holdings, options).dayChangePLN?.toString()).toBe('410');
  });
  it('classifies opposite signs as cushioned', () => {
    const holdings = { contributions: [], dayChangePLN: dec('-10'), dayChangePct: null, valueAtClosePLN: dec('100'), partialSymbols: [], excludedSymbols: [] };
    const options = computeOptionsDayFigures({ lots: [lot()], valuationsByTickerDate: valuations, prevSession: '2026-09-03', dayISO: '2026-09-04', fxUsd: '4' });
    expect(combineDayFigures(holdings, options).optionsRelation).toBe('cushioned');
  });
});
