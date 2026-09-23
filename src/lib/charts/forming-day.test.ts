import { describe, expect, it } from 'vitest';

import { shouldOverlayFormingDay } from './forming-day';

/** Wednesday 2026-08-12 regular session in EDT: 09:30–16:00 ET = 13:30–20:00 UTC. */
const TODAY = '2026-08-12';
const SESSION = {
  openMs: Date.parse('2026-08-12T13:30:00Z'),
  closeMs: Date.parse('2026-08-12T20:00:00Z'),
};
const MID_SESSION = Date.parse('2026-08-12T16:00:00Z');
const PRE_OPEN = Date.parse('2026-08-12T13:29:59Z');
const AT_OPEN = Date.parse('2026-08-12T13:30:00Z');
const POST_CLOSE = Date.parse('2026-08-12T20:00:00Z');
const YESTERDAY = ['2026-08-11'];

describe('shouldOverlayFormingDay', () => {
  it('overlays mid-session when today is not already stored', () => {
    expect(
      shouldOverlayFormingDay({
        todayISO: TODAY,
        nowMs: MID_SESSION,
        session: SESSION,
        existingDates: YESTERDAY,
      }),
    ).toBe(true);
  });

  it('skips before regular open — the headline last is still yesterday', () => {
    expect(
      shouldOverlayFormingDay({
        todayISO: TODAY,
        nowMs: PRE_OPEN,
        session: SESSION,
        existingDates: YESTERDAY,
      }),
    ).toBe(false);
  });

  it('overlays at the open instant (inclusive)', () => {
    expect(
      shouldOverlayFormingDay({
        todayISO: TODAY,
        nowMs: AT_OPEN,
        session: SESSION,
        existingDates: YESTERDAY,
      }),
    ).toBe(true);
  });

  it('overlays after the bell when today is not yet stored', () => {
    expect(
      shouldOverlayFormingDay({
        todayISO: TODAY,
        nowMs: POST_CLOSE,
        session: SESSION,
        existingDates: YESTERDAY,
      }),
    ).toBe(true);
  });

  it('skips a weekend or holiday (`session === null`)', () => {
    expect(
      shouldOverlayFormingDay({
        todayISO: '2026-08-15',
        nowMs: Date.parse('2026-08-15T16:00:00Z'),
        session: null,
        existingDates: ['2026-08-14'],
      }),
    ).toBe(false);
  });

  it('skips when today is already in the stored dates', () => {
    expect(
      shouldOverlayFormingDay({
        todayISO: TODAY,
        nowMs: MID_SESSION,
        session: SESSION,
        existingDates: ['2026-08-11', TODAY],
      }),
    ).toBe(false);
  });

  it('accepts a Map keys iterator as existingDates', () => {
    const bars = new Map([
      ['2026-08-10', '1'],
      ['2026-08-11', '2'],
    ]);
    expect(
      shouldOverlayFormingDay({
        todayISO: TODAY,
        nowMs: MID_SESSION,
        session: SESSION,
        existingDates: bars.keys(),
      }),
    ).toBe(true);
  });
});
