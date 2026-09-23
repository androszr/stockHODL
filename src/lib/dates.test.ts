import { describe, expect, it } from 'vitest';

import { addDaysIso } from './dates';

/**
 * Direct tests for the moved helper (2026-08-16, trim-bundle plan — it lived
 * in `fx/nbp-mapping.ts`, whose own suite keeps exercising the re-export).
 * Pure calendar math: UTC has no DST, so ms math is exact by construction.
 */

describe('addDaysIso', () => {
  it.each([
    // Month boundaries, both directions.
    ['2026-08-31', 1, '2026-09-01'],
    ['2026-09-01', -1, '2026-08-31'],
    // Year boundaries, both directions.
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-01-01', -1, '2025-12-31'],
    // Negative deltas across a month.
    ['2026-08-05', -14, '2026-07-22'],
    // Leap handling.
    ['2024-02-28', 1, '2024-02-29'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2024-03-01', -1, '2024-02-29'],
    // Identity.
    ['2026-03-15', 0, '2026-03-15'],
  ])('%s %+d days → %s', (iso, delta, expected) => {
    expect(addDaysIso(iso, delta)).toBe(expected);
  });

  it('is DST-immune: stepping across the EU and US transition dates stays exact', () => {
    // 2026-03-29 is the EU spring-forward Sunday; 2026-11-01 the US fall-back.
    // Local-time Date math would gain or lose an hour and truncate to the
    // wrong day — UTC ms math cannot.
    expect(addDaysIso('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDaysIso('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDaysIso('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysIso('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('round-trips: +n then −n is the identity across boundaries', () => {
    for (const iso of ['2026-08-05', '2026-01-07', '2024-02-29', '2026-12-31']) {
      for (const delta of [1, 14, 365]) {
        expect(addDaysIso(addDaysIso(iso, delta), -delta)).toBe(iso);
      }
    }
  });

  it('pins the values the nbp-mapping suite has always pinned (compat)', () => {
    // The exact cases from `nbp-mapping.test.ts`'s addDaysIso describe — the
    // re-export and the source must agree forever.
    expect(addDaysIso('2026-08-05', -14)).toBe('2026-07-22');
    expect(addDaysIso('2026-01-07', -14)).toBe('2025-12-24');
    expect(addDaysIso('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDaysIso('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysIso('2026-03-15', 0)).toBe('2026-03-15');
  });
});
