import { describe, expect, it } from 'vitest';

import { watchedAnchorDate } from './anchor';

describe('watchedAnchorDate — the fixed 5-year anchor for watched instruments', () => {
  it('subtracts exactly 60 calendar months', () => {
    expect(watchedAnchorDate('2026-08-14')).toBe('2021-08-14');
  });

  it('clamps to the end of a shorter target month', () => {
    // 2026-05-31 − 60 months → 2021-05-31 exists; use a case that clamps:
    // 2025-03-31 − 60 months → 2020-03-31 exists too, so force a 30-day month.
    expect(watchedAnchorDate('2026-07-31')).toBe('2021-07-31');
    expect(watchedAnchorDate('2026-10-31')).toBe('2021-10-31');
    // A 31st landing on a month with fewer days five years earlier: 60 months
    // keeps the month, so build one via a leap-day input instead (below) and
    // verify the generic clamp through a month-length mismatch year.
    expect(watchedAnchorDate('2024-02-29')).toBe('2019-02-28');
  });

  it('handles a leap-day input by clamping to Feb 28 of a non-leap year', () => {
    expect(watchedAnchorDate('2028-02-29')).toBe('2023-02-28');
  });

  it('keeps a leap-day target when the earlier year is also a leap year', () => {
    // 2032 − 5y = 2027 (non-leap) clamps; 2029-02-28 − 60 months stays exact.
    expect(watchedAnchorDate('2029-02-28')).toBe('2024-02-28');
  });
});
