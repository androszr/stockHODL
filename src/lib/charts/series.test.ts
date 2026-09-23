import { describe, expect, it } from 'vitest';

import {
  downsample,
  emptySeries,
  toReturnPoints,
  type SeriesPayload,
} from './series';

describe('downsample — geometry reduction without value drift', () => {
  const points = Array.from({ length: 1250 }, (_, i) => ({ t: i, v: `${i}.25` }));

  it('keeps the first and last point exactly', () => {
    const sampled = downsample(points, 400);
    expect(sampled[0]).toEqual(points[0]);
    expect(sampled[sampled.length - 1]).toEqual(points[points.length - 1]);
    expect(sampled.length).toBe(400);
  });

  it('never changes a value — every sampled point is an input point', () => {
    const sampled = downsample(points, 400);
    const inputs = new Set(points);
    for (const point of sampled) {
      expect(inputs.has(point)).toBe(true);
      expect(typeof point.v).toBe('string');
    }
  });

  it('returns short series unchanged', () => {
    const short = points.slice(0, 10);
    expect(downsample(short, 400)).toEqual(short);
  });

  it('keeps timestamps strictly ascending', () => {
    const sampled = downsample(points, 37);
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled[i].t).toBeGreaterThan(sampled[i - 1].t);
    }
  });

  it('preserves the candle fields — sampled points carry o/h/l untouched', () => {
    // downsample copies whole points, so the optional candle fields ride
    // through by construction — pinned here so a future rewrite cannot strip
    // them silently.
    const tagged = Array.from({ length: 1250 }, (_, i) => ({
      t: i,
      v: `${i}.25`,
      o: `${i}.1`,
      h: `${i}.9`,
      l: `${i}.05`,
    }));
    const sampled = downsample(tagged, 400);
    for (const point of sampled) {
      expect(point.o).toBe(`${point.t}.1`);
      expect(point.h).toBe(`${point.t}.9`);
      expect(point.l).toBe(`${point.t}.05`);
    }
  });

  it('preserves the return tag — sampled points carry their `r` untouched', () => {
    const tagged = Array.from({ length: 1250 }, (_, i) => ({
      t: i,
      v: `${i}.25`,
      r: `${i}.5`,
    }));
    const sampled = downsample(tagged, 400);
    for (const point of sampled) {
      expect(point.r).toBe(`${point.t}.5`);
      expect(typeof point.r).toBe('string');
    }
  });
});

describe('toReturnPoints — the return curve riding on a portfolio payload', () => {
  it('keeps only points carrying `r`, with the percent as the plotted value', () => {
    const result = toReturnPoints([
      { t: 1, v: '4000' }, // pre-first-buy: no basis, no r — dropped
      { t: 2, v: '4400', r: '10' },
      { t: 3, v: '4800', r: '20', p: 'post' },
    ]);
    expect(result).toEqual([
      { t: 2, v: '10' },
      { t: 3, v: '20', p: 'post' },
    ]);
    for (const point of result) expect(typeof point.v).toBe('string');
  });

  it('absent stays absent — no `p` key and no `r` key materialize on output', () => {
    const result = toReturnPoints([{ t: 1, v: '4400', r: '10' }]);
    expect('p' in result[0]).toBe(false);
    expect('r' in result[0]).toBe(false);
  });

  it('a series with no return curve at all maps to empty', () => {
    expect(toReturnPoints([{ t: 1, v: '100' }, { t: 2, v: '110' }])).toEqual([]);
  });
});

describe('emptySeries', () => {
  it('is honestly empty', () => {
    expect(emptySeries()).toEqual({
      points: [],
      partialDays: 0,
      excludedSymbols: [],
      anchorDate: null,
    });
    expect(emptySeries('2026-01-02').anchorDate).toBe('2026-01-02');
  });

  it('carries NO estimatedFrom key — the p?/r? optional-field precedent', () => {
    // Only the two options series ever set it. Every other payload must
    // serialize byte-identically to before it existed, so an added optional
    // field cannot quietly widen a 5Y daily response.
    expect(JSON.stringify(emptySeries())).toBe(
      '{"points":[],"partialDays":0,"excludedSymbols":[],"anchorDate":null}',
    );
    expect(Object.keys(emptySeries())).not.toContain('estimatedFrom');
  });

  it('serializes estimatedFrom only when it is actually set', () => {
    const disclosed: SeriesPayload = { ...emptySeries('2026-05-20'), estimatedFrom: '2026-08-17' };
    expect(JSON.parse(JSON.stringify(disclosed)).estimatedFrom).toBe('2026-08-17');
  });
});
