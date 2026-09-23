import { describe, expect, it } from 'vitest';

import { watchedAnchorDate } from '@/lib/watchlist/anchor';

import { instrumentAnchorDate } from './anchor';

describe('instrumentAnchorDate', () => {
  it('keeps a first trade OLDER than the five-year floor', () => {
    // Real history that predates the floor stays chartable.
    expect(instrumentAnchorDate('2026-08-20', '2019-03-04')).toBe('2019-03-04');
  });

  it('widens a first trade INSIDE the floor down to the floor', () => {
    expect(instrumentAnchorDate('2026-08-20', '2024-01-15')).toBe('2021-08-20');
  });

  it('falls back to the floor with no trade at all (watched)', () => {
    expect(instrumentAnchorDate('2026-08-20', null)).toBe('2021-08-20');
  });

  it('widens the CRWD case — bought 2026-08-17, charts from 2021-08-20', () => {
    expect(instrumentAnchorDate('2026-08-20', '2026-08-17')).toBe('2021-08-20');
  });

  it('agrees with the watched floor exactly, so held and watched anchor alike', () => {
    expect(instrumentAnchorDate('2026-08-20', null)).toBe(watchedAnchorDate('2026-08-20'));
  });

  it('inherits end-of-month clamping from addMonthsIso', () => {
    // 2024-02-29 − 60 months → 2019-02-28 (2019 was not a leap year).
    expect(instrumentAnchorDate('2024-02-29', null)).toBe('2019-02-28');
    expect(instrumentAnchorDate('2024-02-29', '2024-02-01')).toBe('2019-02-28');
  });

  it('returns the floor when the trade lands exactly on it', () => {
    expect(instrumentAnchorDate('2026-08-20', '2021-08-20')).toBe('2021-08-20');
  });
});
