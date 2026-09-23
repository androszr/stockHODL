import { describe, expect, it } from 'vitest';

import { toTrendDays } from './day-trend';
import { totalValuationPoints } from './total-trend';
import { EQUITY_TREND_SCALE } from './trend-scale';

const sessions = ['2026-09-14', '2026-09-15', '2026-09-16'];
const fx = new Map([['USD', new Map([['2026-09-14', '4'], ['2026-09-15', '4'], ['2026-09-16', '4']])]]);

describe('totalValuationPoints', () => {
  it('sums units × close × rate into one PLN point per session', () => {
    const points = totalValuationPoints(
      sessions,
      [
        { key: 'a', units: '10', currency: 'USD' },
        { key: 'b', units: '2', currency: 'PLN' },
      ],
      new Map([
        ['a', [{ asOf: '2026-09-14', close: '100' }, { asOf: '2026-09-15', close: '110' }, { asOf: '2026-09-16', close: '99' }]],
        ['b', [{ asOf: '2026-09-14', close: '50' }, { asOf: '2026-09-15', close: '50' }, { asOf: '2026-09-16', close: '50' }]],
      ]),
      fx,
    );
    expect(points).toEqual([
      { asOf: '2026-09-14', close: '4100', source: 'close' },
      { asOf: '2026-09-15', close: '4500', source: 'close' },
      { asOf: '2026-09-16', close: '4060', source: 'close' },
    ]);
    const graded = toTrendDays(sessions, points, EQUITY_TREND_SCALE);
    expect(graded.map((slot) => slot?.direction)).toEqual(['gain', 'loss']);
  });

  it('holes a session when any position has no figure for it, instead of summing a shrunken book', () => {
    const points = totalValuationPoints(
      sessions,
      [{ key: 'a', units: '1', currency: 'PLN' }, { key: 'b', units: '1', currency: 'PLN' }],
      new Map([
        ['a', [{ asOf: '2026-09-14', close: '10' }, { asOf: '2026-09-15', close: '11' }, { asOf: '2026-09-16', close: '12' }]],
        ['b', [{ asOf: '2026-09-14', close: '10' }, { asOf: '2026-09-16', close: '10' }]],
      ]),
    );
    expect(points.map((point) => point.asOf)).toEqual(['2026-09-14', '2026-09-16']);
    expect(toTrendDays(sessions, points, EQUITY_TREND_SCALE)).toEqual([null, null]);
  });

  it('holes a session whose FX rate is missing', () => {
    const points = totalValuationPoints(
      sessions,
      [{ key: 'a', units: '1', currency: 'USD' }],
      new Map([['a', sessions.map((asOf) => ({ asOf, close: '1' }))]]),
      new Map([['USD', new Map([['2026-09-14', '4'], ['2026-09-16', '4']])]]),
    );
    expect(points.map((point) => point.asOf)).toEqual(['2026-09-14', '2026-09-16']);
  });

  it('keeps the options book in USD and tags the total a mark when any leg is one', () => {
    const points = totalValuationPoints(
      ['2026-09-14', '2026-09-15'],
      [{ key: 'O1', units: '200', currency: 'USD' }, { key: 'O2', units: '100', currency: 'USD' }],
      new Map([
        ['O1', [{ asOf: '2026-09-14', close: '1.5', source: 'close' }, { asOf: '2026-09-15', close: '2', source: 'mark' }]],
        ['O2', [{ asOf: '2026-09-14', close: '3', source: 'close' }, { asOf: '2026-09-15', close: '3', source: 'close' }]],
      ]),
      new Map(),
      { convert: false },
    );
    expect(points).toEqual([
      { asOf: '2026-09-14', close: '600', source: 'close' },
      { asOf: '2026-09-15', close: '700', source: 'mark' },
    ]);
  });

  it('is empty for an empty book', () => {
    expect(totalValuationPoints(sessions, [], new Map())).toEqual([]);
  });
});
