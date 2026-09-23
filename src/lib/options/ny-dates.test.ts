import { describe, expect, it } from 'vitest';

import {
  OPTION_HISTORY_LOOKBACK_MONTHS,
  addCalendarDaysISO,
  calendarDaysBetween,
  optionBackfillFrom,
} from './ny-dates';

/**
 * `addCalendarDaysISO` bounds the loader's mark window. A helper that drifts a
 * day across a DST boundary would silently narrow that window and drop a
 * legitimate pair — so the boundaries are what these tests are about.
 */
describe('addCalendarDaysISO', () => {
  it('is the identity at zero days', () => {
    expect(addCalendarDaysISO('2026-08-15', 0)).toBe('2026-08-15');
  });

  it('crosses a month boundary AND the US DST switch (08 Mar 2026)', () => {
    expect(addCalendarDaysISO('2026-03-09', -10)).toBe('2026-02-27');
  });

  it('crosses a year boundary backwards', () => {
    expect(addCalendarDaysISO('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('crosses a year boundary forwards', () => {
    expect(addCalendarDaysISO('2025-12-31', 1)).toBe('2026-01-01');
  });

  it('handles a leap day', () => {
    expect(addCalendarDaysISO('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDaysISO('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('pads single-digit months and days', () => {
    expect(addCalendarDaysISO('2026-08-15', -10)).toBe('2026-08-05');
  });

  it('round-trips with calendarDaysBetween across the DST switch', () => {
    expect(calendarDaysBetween('2026-03-09', addCalendarDaysISO('2026-03-09', -10))).toBe(10);
  });
});

/**
 * `optionBackfillFrom` bounds the one-off option-close backfill (2026-08-20).
 * Too wide and it pays the vendor for bars no lot could ever chart; too narrow
 * and the three-month line it exists to draw is short.
 */
describe('optionBackfillFrom', () => {
  it('returns the three-month floor when the lot predates it', () => {
    // CRM: lot opened 2026-05-26, well before the 2026-05-20 floor.
    expect(optionBackfillFrom('2026-08-20', '2026-05-01')).toBe('2026-05-20');
  });

  it('returns the trade date when the lot is newer than the floor', () => {
    // ZTS: opened 2026-08-14 — nothing before it can become a point.
    expect(optionBackfillFrom('2026-08-20', '2026-08-14')).toBe('2026-08-14');
  });

  it('returns the floor when the lot opened exactly on it', () => {
    expect(optionBackfillFrom('2026-08-20', '2026-05-20')).toBe('2026-05-20');
  });

  it('clamps the end of the month via addMonthsIso', () => {
    // 31 May − 3M → 28 Feb (2026 is not a leap year), never an invalid 31 Feb.
    expect(optionBackfillFrom('2026-05-31', '2020-01-01')).toBe('2026-02-28');
  });

  it('crosses a year boundary', () => {
    expect(optionBackfillFrom('2026-02-10', '2024-01-01')).toBe('2025-11-10');
  });

  it('is three months by the exported constant', () => {
    expect(OPTION_HISTORY_LOOKBACK_MONTHS).toBe(3);
  });
});
