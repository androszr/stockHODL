import { describe, expect, it } from 'vitest';

import { mergeCalendarSources } from './calendar-merge';
import { extendedAttribution, type CalendarOverride } from './market-clock';

/**
 * The tests shaped like the REAL production failure: the vendor's upcoming
 * calendar is future-only, so a closure row that has passed exists ONLY in
 * storage — and the attribution math must see it through the merge, not
 * through a hand-delivered override (which is how the original hermetic suite
 * stayed green over a broken pipeline).
 */

const LABOR_DAY: CalendarOverride = { date: '2026-09-07', status: 'closed' };
const THANKSGIVING: CalendarOverride = { date: '2026-11-26', status: 'closed' };
const THANKSGIVING_FRIDAY: CalendarOverride = {
  date: '2026-11-27',
  status: 'early-close',
  openMs: Date.UTC(2026, 10, 27, 14, 30),
  closeMs: Date.UTC(2026, 10, 27, 18, 0),
};

describe('mergeCalendarSources — the durable past joined to the future-only feed', () => {
  it('a past holiday PRESENT in storage but ABSENT from the fresh fetch survives, and attribution over the MERGED set dates the reading to the pre-holiday Friday', () => {
    // The morning after Labor Day (Tue 2026-09-08 02:00 ET = 06:00Z). The
    // vendor stopped advertising the Monday closure the moment it passed;
    // only the stored row knows it. Without it the scan would stamp Friday's
    // persisted after-hours pair to a Monday session that never happened.
    const stored: CalendarOverride[] = [LABOR_DAY];
    const fetched: CalendarOverride[] = [THANKSGIVING]; // still upcoming

    const merged = mergeCalendarSources(stored, fetched);
    expect(merged).toContainEqual(LABOR_DAY);

    expect(extendedAttribution(Date.UTC(2026, 8, 8, 6, 0), merged, '2026-01-01')).toEqual({
      kind: 'late',
      live: false,
      // Friday 2026-09-04's late end: 20:00 ET + 4 h = Sat 00:00Z — the last
      // day trading actually happened, never the holiday Monday.
      endedAtMs: Date.UTC(2026, 8, 5, 0, 0),
    });
  });

  it('a stored early-close row keeps shortening the late session after it passes', () => {
    // Saturday after an early-close Friday that the vendor no longer lists:
    // late end must be close (18:00Z) + 4 h = 22:00Z, not 20:00 ET.
    const merged = mergeCalendarSources([THANKSGIVING_FRIDAY], []);
    expect(extendedAttribution(Date.UTC(2026, 10, 28, 12, 0), merged, '2026-01-01')).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: Date.UTC(2026, 10, 27, 22, 0),
    });
  });

  it('the FRESH row wins a shared date — a published correction propagates', () => {
    const storedStale: CalendarOverride[] = [{ date: '2026-11-27', status: 'closed' }];
    expect(mergeCalendarSources(storedStale, [THANKSGIVING_FRIDAY])).toEqual([
      THANKSGIVING_FRIDAY,
    ]);
  });

  it('early-close instants survive the merge from either side', () => {
    expect(mergeCalendarSources([THANKSGIVING_FRIDAY], [])).toEqual([THANKSGIVING_FRIDAY]);
    expect(mergeCalendarSources([], [THANKSGIVING_FRIDAY])).toEqual([THANKSGIVING_FRIDAY]);
  });

  it('empty storage → the fetched list unchanged; output always sorted by date', () => {
    expect(mergeCalendarSources([], [THANKSGIVING, LABOR_DAY])).toEqual([
      LABOR_DAY,
      THANKSGIVING,
    ]);
    expect(mergeCalendarSources([THANKSGIVING], [LABOR_DAY])).toEqual([
      LABOR_DAY,
      THANKSGIVING,
    ]);
  });
});
