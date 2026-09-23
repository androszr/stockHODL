import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dec, toNumeric } from '@/lib/money';

import {
  optionsSessionPercentSeries,
  optionsSessionValuePoints,
} from './options-intraday';

const SESSION = { openMs: 1_000, closeMs: 10_000 };

describe('optionsSessionValuePoints', () => {
  it('carries the last print forward and never interpolates a hole', () => {
    const lots = [{ ticker: 'O:AAPL', quantity: '2', sharesPerContract: '100' }];
    const points = optionsSessionValuePoints(
      lots,
      new Map([
        [
          'O:AAPL',
          [
            { t: 2_000, close: '5' },
            { t: 4_000, close: '6' },
          ],
        ],
      ]),
      new Map([['O:AAPL', '4']]),
      SESSION,
    );
    // 2 × 100 × price. Seed 4 at open, then 5, then 6.
    expect(points.map((p) => p.v)).toEqual([
      toNumeric(dec('800')),
      toNumeric(dec('1000')),
      toNumeric(dec('1200')),
      toNumeric(dec('1200')),
    ]);
    expect(points[points.length - 1].t).toBe(SESSION.closeMs);
  });

  it('excludes an unpriced ticker instead of zeroing it', () => {
    const points = optionsSessionValuePoints(
      [
        { ticker: 'O:AAPL', quantity: '1', sharesPerContract: '100' },
        { ticker: 'O:MSFT', quantity: '1', sharesPerContract: '100' },
      ],
      new Map([['O:AAPL', [{ t: 2_000, close: '5' }]]]),
      new Map([['O:AAPL', '4']]),
      SESSION,
    );
    // Only AAPL: 1 × 100 × 4 at open, then 5.
    expect(points[0].v).toBe(toNumeric(dec('400')));
    expect(points[1].v).toBe(toNumeric(dec('500')));
  });

  it('yields no path when the book never printed in session', () => {
    const points = optionsSessionValuePoints(
      [{ ticker: 'O:AAPL', quantity: '1', sharesPerContract: '100' }],
      new Map(),
      new Map([['O:AAPL', '4']]),
      SESSION,
    );
    expect(points).toEqual([]);
  });

  it('ignores prints outside the shared session rather than seeding a flat', () => {
    const points = optionsSessionValuePoints(
      [{ ticker: 'O:AAPL', quantity: '1', sharesPerContract: '100' }],
      new Map([['O:AAPL', [{ t: 50, close: '9' }]]]),
      new Map([['O:AAPL', '4']]),
      SESSION,
    );
    expect(points).toEqual([]);
  });

  it('keeps a sparse book: a silent contract holds its seed, not a zero', () => {
    const points = optionsSessionValuePoints(
      [
        { ticker: 'O:AAPL', quantity: '1', sharesPerContract: '100' },
        { ticker: 'O:MSFT', quantity: '2', sharesPerContract: '100' },
      ],
      new Map([['O:AAPL', [{ t: 2_000, close: '5' }]]]),
      new Map([
        ['O:AAPL', '4'],
        ['O:MSFT', '10'],
      ]),
      SESSION,
    );
    // Open: 400 + 2_000. After AAPL prints 5: 500 + 2_000. MSFT never zeros.
    expect(points[0].v).toBe(toNumeric(dec('2400')));
    expect(points[1].v).toBe(toNumeric(dec('2500')));
  });
});

describe('optionsSessionPercentSeries', () => {
  it('is percent from the previous-close book, USD-only', () => {
    const series = optionsSessionPercentSeries(
      [{ ticker: 'O:AAPL', quantity: '1', sharesPerContract: '100' }],
      new Map([['O:AAPL', [{ t: 2_000, close: '3.6432' }]]]),
      new Map([['O:AAPL', '4']]),
      SESSION,
    );
    expect(dec(series[0].p).isZero()).toBe(true);
    expect(dec(series[series.length - 1].p).equals(dec('-8.92'))).toBe(true);
  });

  it('does not ship a flat 0% path when 5-minute prints are missing', () => {
    const series = optionsSessionPercentSeries(
      [{ ticker: 'O:AAPL', quantity: '1', sharesPerContract: '100' }],
      new Map([['O:AAPL', []]]),
      new Map([['O:AAPL', '4']]),
      SESSION,
    );
    expect(series).toEqual([]);
  });
});

describe('money discipline', () => {
  it('does not call Number() or parseFloat', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./options-intraday.ts', import.meta.url)),
      'utf8',
    );
    const banned = new RegExp(['parse' + 'Float', 'Numb' + 'er\\('].join('|'));
    expect(source).not.toMatch(banned);
  });
});
