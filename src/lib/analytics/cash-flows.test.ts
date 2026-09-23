import { describe, expect, it } from 'vitest';

import type { EngineTransaction } from '@/lib/position-engine';

import {
  buildCashFlows,
  externalFlowsByDay,
  mapFlowsToAxis,
  netDayFlow,
  type DayFlow,
} from './cash-flows';
import { dec, ZERO } from '@/lib/money';

let seq = 0;
function tx(over: Partial<EngineTransaction>): EngineTransaction {
  seq += 1;
  return {
    id: `t${seq}`,
    instrumentId: 'i1',
    symbol: 'AAPL',
    displayName: 'Apple',
    currency: 'USD',
    side: 'buy',
    quantity: '10',
    price: '100',
    fees: '5',
    fxRateToBase: '4',
    tradeDate: '2024-01-02',
    createdAt: new Date('2024-01-02T00:00:00Z'),
    ...over,
  };
}

describe('buildCashFlows', () => {
  it('signs a buy negative and adds the fees into it', () => {
    const [flow] = buildCashFlows([tx({})]);
    // (10 x 100 + 5) x 4 = 4020, money OUT.
    expect(flow.amountPLN.toString()).toBe('-4020');
    expect(flow.dateISO).toBe('2024-01-02');
  });

  it('signs a sell positive and subtracts the fees from it', () => {
    const [flow] = buildCashFlows([tx({ side: 'sell' })]);
    // (10 x 100 - 5) x 4 = 3980, money IN.
    expect(flow.amountPLN.toString()).toBe('3980');
  });

  it('uses the FROZEN trade-date rate, not a current one', () => {
    const flows = buildCashFlows([
      tx({ tradeDate: '2020-01-02', fxRateToBase: '3.8' }),
      tx({ tradeDate: '2024-01-02', fxRateToBase: '4.2' }),
    ]);
    expect(flows[0].amountPLN.toString()).toBe('-3819');
    expect(flows[1].amountPLN.toString()).toBe('-4221');
  });

  it('treats a PLN row at rate 1', () => {
    const [flow] = buildCashFlows([
      tx({ currency: 'PLN', symbol: 'CDR.WA', fxRateToBase: '1', fees: '0' }),
    ]);
    expect(flow.amountPLN.toString()).toBe('-1000');
  });

  it('handles a zero fee without changing the gross', () => {
    const [flow] = buildCashFlows([tx({ fees: '0', fxRateToBase: '1' })]);
    expect(flow.amountPLN.toString()).toBe('-1000');
  });

  it('drops every transaction of an excluded instrument, both sides', () => {
    const flows = buildCashFlows(
      [
        tx({ instrumentId: 'bad', symbol: 'XYZ.WA' }),
        tx({ instrumentId: 'bad', symbol: 'XYZ.WA', side: 'sell' }),
        tx({ instrumentId: 'good', symbol: 'AAPL' }),
      ],
      { excludeInstrumentIds: new Set(['bad']) },
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].amountPLN.isNegative()).toBe(true);
  });

  it('retains a closed position that was not named as excluded', () => {
    // "Open AND unpriceable" is the exclusion predicate, never "unpriceable":
    // a fully sold non-US holding has complete flows on both sides.
    const flows = buildCashFlows(
      [
        tx({ instrumentId: 'closed', tradeDate: '2020-01-02' }),
        tx({ instrumentId: 'closed', side: 'sell', tradeDate: '2021-01-02' }),
      ],
      { excludeInstrumentIds: new Set(['stillOpen']) },
    );
    expect(flows).toHaveLength(2);
  });

  it('returns the flows ascending by date', () => {
    const flows = buildCashFlows([
      tx({ tradeDate: '2024-06-01' }),
      tx({ tradeDate: '2023-01-15' }),
      tx({ tradeDate: '2024-01-02' }),
    ]);
    expect(flows.map((f) => f.dateISO)).toEqual(['2023-01-15', '2024-01-02', '2024-06-01']);
  });

  it('returns nothing for no transactions', () => {
    expect(buildCashFlows([])).toEqual([]);
  });
});

describe('externalFlowsByDay', () => {
  it('negates the investor sign so a buy is money INTO the portfolio', () => {
    const flows = buildCashFlows([tx({ fxRateToBase: '1', fees: '0' })]);
    const byDay = externalFlowsByDay(flows);
    expect(byDay.get('2024-01-02')?.inflowPLN.toString()).toBe('1000');
    expect(byDay.get('2024-01-02')?.outflowPLN.toString()).toBe('0');
  });

  /**
   * Bug audit 2026-08-19, major 1: a single netted figure per day cannot
   * describe a day that both bought and sold, and TWRR's liquidation branch
   * needs both halves to measure such a day at all.
   */
  it('keeps both directions GROSS on a day that both bought and sold', () => {
    const flows = buildCashFlows([
      tx({ tradeDate: '2024-03-01', fxRateToBase: '1', fees: '0' }),
      tx({ tradeDate: '2024-03-01', side: 'sell', fxRateToBase: '1', fees: '0', quantity: '4' }),
    ]);
    const byDay = externalFlowsByDay(flows);
    const flow = byDay.get('2024-03-01');
    expect(flow?.inflowPLN.toString()).toBe('1000');
    expect(flow?.outflowPLN.toString()).toBe('400');
    // …and the net the ordinary TWRR day still uses is derived from them.
    expect(netDayFlow(flow).toString()).toBe('600');
    expect(byDay.size).toBe(1);
  });

  it('treats an absent day as no movement rather than as null', () => {
    expect(netDayFlow(undefined).toString()).toBe('0');
  });
});

/**
 * Bug audit 2026-08-18, blocker 1: flows were matched to the valuation axis
 * by an EXACT date string, so a trade dated on a non-trading day silently
 * vanished from the time-weighted chain and its money showed up as pure
 * performance the next trading day.
 */
describe('mapFlowsToAxis', () => {
  // A real US trading week: Friday, then the weekend gap, then Monday.
  const axis = ['2024-01-04', '2024-01-05', '2024-01-08', '2024-01-09'];

  // Entries are written as NET amounts (positive = in, negative = out) and
  // split into the gross shape the map actually carries.
  const flows = (entries: [string, string][]) =>
    new Map<string, DayFlow>(
      entries.map(([date, amount]) => [
        date,
        dec(amount).isNegative()
          ? { inflowPLN: ZERO, outflowPLN: dec(amount).negated() }
          : { inflowPLN: dec(amount), outflowPLN: ZERO },
      ]),
    );

  const total = (amounts: ReadonlyMap<string, DayFlow>) =>
    [...amounts.values()].reduce((acc, value) => acc.plus(netDayFlow(value)), ZERO);

  it('snaps a SATURDAY buy forward to the next axis day', () => {
    // The auditor's repro: 1 000 zł bought on a Saturday against a 1 000 zł
    // portfolio used to read +100 % cumulative and +5818 % annualized.
    const result = mapFlowsToAxis(flows([['2024-01-06', '1000']]), axis);
    expect(netDayFlow(result.byDay.get('2024-01-08')).toString()).toBe('1000');
    expect(result.unmappedPLN.isZero()).toBe(true);
    expect(result.unmappedDates).toEqual([]);
  });

  it('snaps a market-HOLIDAY buy forward to the next axis day', () => {
    // 2024-01-15 was Martin Luther King Jr. Day: a weekday with no bar.
    const holidayAxis = ['2024-01-12', '2024-01-16', '2024-01-17'];
    const result = mapFlowsToAxis(flows([['2024-01-15', '500']]), holidayAxis);
    expect(netDayFlow(result.byDay.get('2024-01-16')).toString()).toBe('500');
    expect(result.unmappedPLN.isZero()).toBe(true);
  });

  it('accumulates a flow dated BEFORE the axis onto the first axis day', () => {
    const result = mapFlowsToAxis(
      flows([
        ['2023-12-20', '200'],
        ['2024-01-04', '300'],
      ]),
      axis,
    );
    expect(netDayFlow(result.byDay.get('2024-01-04')).toString()).toBe('500');
    expect(result.unmappedPLN.isZero()).toBe(true);
  });

  it('refuses — never zeroes — a flow dated AFTER the last axis day', () => {
    const result = mapFlowsToAxis(
      flows([
        ['2024-01-05', '100'],
        ['2024-02-01', '750'],
      ]),
      axis,
    );
    expect(netDayFlow(result.byDay.get('2024-01-05')).toString()).toBe('100');
    expect(result.unmappedPLN.toString()).toBe('750');
    expect(result.unmappedDates).toEqual(['2024-02-01']);
  });

  it('reconciles: Σ mapped + unmapped == Σ input, always', () => {
    const input = flows([
      ['2023-12-31', '50'],
      ['2024-01-06', '1000'],
      ['2024-01-08', '-200'],
      ['2024-03-01', '25'],
    ]);
    const result = mapFlowsToAxis(input, axis);
    expect(total(result.byDay).plus(result.unmappedPLN).toString()).toBe(total(input).toString());
  });

  it('treats an empty axis as entirely unmapped rather than silently empty', () => {
    const result = mapFlowsToAxis(flows([['2024-01-06', '1000']]), []);
    expect(result.byDay.size).toBe(0);
    expect(result.unmappedPLN.toString()).toBe('1000');
    expect(result.unmappedDates).toEqual(['2024-01-06']);
  });

  it('lists BOTH unmapped dates even when they net to nothing', () => {
    // The reconciliation figure is a net, so an unmapped buy and an unmapped
    // sale of the same size cancel in `unmappedPLN` while both are still
    // missing from the chain. The DATES are what the caller refuses on.
    const result = mapFlowsToAxis(
      flows([
        ['2024-02-01', '500'],
        ['2024-02-02', '-500'],
      ]),
      axis,
    );
    expect(result.unmappedPLN.isZero()).toBe(true);
    expect(result.unmappedDates).toEqual(['2024-02-01', '2024-02-02']);
  });

  it('leaves a flow that already lands on an axis day exactly where it is', () => {
    const result = mapFlowsToAxis(flows([['2024-01-09', '400']]), axis);
    expect(netDayFlow(result.byDay.get('2024-01-09')).toString()).toBe('400');
    expect(result.byDay.size).toBe(1);
  });
});
