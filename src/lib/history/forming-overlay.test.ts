import { describe, expect, it } from 'vitest';

import { equityOverlayPoint, patchDailyCloses } from './forming-overlay';

const TODAY = '2026-08-12';

describe('equityOverlayPoint', () => {
  it('sets v as a decimal string at midnight UTC of today', () => {
    const point = equityOverlayPoint({ todayISO: TODAY, last: '105.50' });
    expect(point.t).toBe(Date.parse(`${TODAY}T00:00:00Z`));
    expect(point.v).toBe('105.5');
    expect(typeof point.v).toBe('string');
    expect('o' in point).toBe(false);
    expect('h' in point).toBe(false);
    expect('l' in point).toBe(false);
  });

  it('renormalises a padded numeric through dec()', () => {
    const point = equityOverlayPoint({ todayISO: TODAY, last: '123.45000000' });
    expect(point.v).toBe('123.45');
  });

  it('includes o/h/l only when all three are present, as decimal strings', () => {
    const point = equityOverlayPoint({
      todayISO: TODAY,
      last: '105.50',
      open: '104.00000000',
      high: '106.10',
      low: '103.25',
    });
    expect(point.o).toBe('104');
    expect(point.h).toBe('106.1');
    expect(point.l).toBe('103.25');
    expect(typeof point.o).toBe('string');
    expect(typeof point.h).toBe('string');
    expect(typeof point.l).toBe('string');
  });

  it('omits o/h/l when any of the three is missing', () => {
    const noLow = equityOverlayPoint({
      todayISO: TODAY,
      last: '105',
      open: '104',
      high: '106',
      low: null,
    });
    expect('o' in noLow).toBe(false);
    expect('h' in noLow).toBe(false);
    expect('l' in noLow).toBe(false);

    const noHigh = equityOverlayPoint({
      todayISO: TODAY,
      last: '105',
      open: '104',
      high: undefined,
      low: '103',
    });
    expect('o' in noHigh).toBe(false);
  });

  it('omits o/h/l when last sits outside the wick rather than clamping', () => {
    const above = equityOverlayPoint({
      todayISO: TODAY,
      last: '110',
      open: '104',
      high: '106',
      low: '103',
    });
    expect(above.v).toBe('110');
    expect('o' in above).toBe(false);
    expect('h' in above).toBe(false);
    expect('l' in above).toBe(false);

    const below = equityOverlayPoint({
      todayISO: TODAY,
      last: '100',
      open: '104',
      high: '106',
      low: '103',
    });
    expect(below.v).toBe('100');
    expect('o' in below).toBe(false);

    const atHigh = equityOverlayPoint({
      todayISO: TODAY,
      last: '106.10',
      open: '104',
      high: '106.10',
      low: '103',
    });
    expect(atHigh.o).toBe('104');
    expect(atHigh.h).toBe('106.1');
    expect(atHigh.l).toBe('103');
  });
});

describe('patchDailyCloses', () => {
  it('copies maps and sets today only when absent', () => {
    const aapl = new Map([
      ['2026-08-11', '100'],
      [TODAY, '101'],
    ]);
    const msft = new Map([['2026-08-11', '200']]);
    const input = new Map<string, Map<string, string>>([
      ['aapl', aapl],
      ['msft', msft],
    ]);
    const lastById = new Map([
      ['aapl', '105.50'],
      ['msft', '210.00000000'],
    ]);

    const patched = patchDailyCloses(input, TODAY, lastById);

    expect(patched.get('aapl')?.get(TODAY)).toBe('101');
    expect(patched.get('msft')?.get(TODAY)).toBe('210');
    expect(aapl.get(TODAY)).toBe('101');
    expect(msft.has(TODAY)).toBe(false);
    expect(patched.get('aapl')).not.toBe(aapl);
    expect(patched.get('msft')).not.toBe(msft);
    expect(patched).not.toBe(input);
  });

  it('does not invent an instrument that had no closes map', () => {
    const input = new Map<string, Map<string, string>>([['aapl', new Map([['2026-08-11', '100']])]]);
    const patched = patchDailyCloses(input, TODAY, new Map([['ghost', '1']]));
    expect(patched.has('ghost')).toBe(false);
    expect(patched.get('aapl')?.has(TODAY)).toBe(false);
  });

  it('leaves instruments without a live last untouched', () => {
    const input = new Map<string, Map<string, string>>([
      ['aapl', new Map([['2026-08-11', '100']])],
      ['msft', new Map([['2026-08-11', '200']])],
    ]);
    const patched = patchDailyCloses(input, TODAY, new Map([['aapl', '105']]));
    expect(patched.get('aapl')?.get(TODAY)).toBe('105');
    expect(patched.get('msft')?.has(TODAY)).toBe(false);
  });

  it('does not write today onto an empty closes map', () => {
    const empty = new Map<string, string>();
    const aapl = new Map([['2026-08-11', '100']]);
    const input = new Map<string, Map<string, string>>([
      ['miss', empty],
      ['aapl', aapl],
    ]);
    const patched = patchDailyCloses(
      input,
      TODAY,
      new Map([
        ['miss', '105'],
        ['aapl', '105'],
      ]),
    );
    expect(patched.get('miss')?.size).toBe(0);
    expect(patched.get('miss')?.has(TODAY)).toBe(false);
    expect(empty.size).toBe(0);
    expect(patched.get('aapl')?.get(TODAY)).toBe('105');
  });
});
