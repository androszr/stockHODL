import { describe, expect, it } from 'vitest';

import { extendCoverage, missingRanges } from './coverage';

describe('missingRanges — coverage-gap arithmetic', () => {
  const covered = { from: '2026-07-01', to: '2026-08-10' };

  it('full coverage → zero gaps, zero provider requests', () => {
    expect(missingRanges({ from: '2026-07-10', to: '2026-08-01' }, covered)).toEqual([]);
    // Exact edges are covered too — inclusive on both sides.
    expect(missingRanges({ from: '2026-07-01', to: '2026-08-10' }, covered)).toEqual([]);
  });

  it('no coverage at all → the whole want is one gap', () => {
    expect(missingRanges({ from: '2026-07-01', to: '2026-08-10' }, null)).toEqual([
      { from: '2026-07-01', to: '2026-08-10' },
    ]);
  });

  it('extends left: entering 5Y after 1M fetches only the older tail', () => {
    expect(missingRanges({ from: '2021-08-11', to: '2026-08-10' }, covered)).toEqual([
      { from: '2021-08-11', to: '2026-06-30' },
    ]);
  });

  it('extends right: a new day fetches only that day', () => {
    expect(missingRanges({ from: '2026-08-01', to: '2026-08-11' }, covered)).toEqual([
      { from: '2026-08-11', to: '2026-08-11' },
    ]);
  });

  it('extends both sides with exactly two gaps', () => {
    expect(missingRanges({ from: '2026-06-01', to: '2026-08-12' }, covered)).toEqual([
      { from: '2026-06-01', to: '2026-06-30' },
      { from: '2026-08-11', to: '2026-08-12' },
    ]);
  });

  it('a want disjoint to the right bridges the hole — the union stays one interval', () => {
    expect(missingRanges({ from: '2026-09-01', to: '2026-09-10' }, covered)).toEqual([
      { from: '2026-08-11', to: '2026-09-10' },
    ]);
  });

  it('a want disjoint to the left bridges the hole symmetrically', () => {
    expect(missingRanges({ from: '2026-05-01', to: '2026-05-10' }, covered)).toEqual([
      { from: '2026-05-01', to: '2026-06-30' },
    ]);
  });

  it('an inverted want returns no gaps', () => {
    expect(missingRanges({ from: '2026-08-10', to: '2026-08-01' }, covered)).toEqual([]);
  });
});

describe('extendCoverage — the post-success merge', () => {
  it('starts coverage from nothing', () => {
    expect(extendCoverage(null, { from: '2026-08-01', to: '2026-08-10' })).toEqual({
      from: '2026-08-01',
      to: '2026-08-10',
    });
  });

  it('extends left and right without shrinking', () => {
    const covered = { from: '2026-07-01', to: '2026-08-10' };
    expect(extendCoverage(covered, { from: '2026-06-01', to: '2026-06-30' })).toEqual({
      from: '2026-06-01',
      to: '2026-08-10',
    });
    expect(extendCoverage(covered, { from: '2026-08-11', to: '2026-08-12' })).toEqual({
      from: '2026-07-01',
      to: '2026-08-12',
    });
    // A fetched range inside coverage changes nothing.
    expect(extendCoverage(covered, { from: '2026-07-10', to: '2026-07-20' })).toEqual(covered);
  });
});
