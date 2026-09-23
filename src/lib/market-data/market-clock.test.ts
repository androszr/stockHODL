import { describe, expect, it } from 'vitest';

import {
  extendedAttribution,
  nextSessionActivity,
  nextTransition,
  nyDateISOAt,
  nyOffsetMinutes,
  recentSessionDatesISO,
  regularSessionFor,
  statusAt,
  type CalendarOverride,
} from './market-clock';

/**
 * The DST/holiday proof. Every case pins an exact UTC instant — the US and EU
 * change clocks on different weekends (US 2026-03-08 / EU 2026-03-29; US
 * 2026-11-01 / EU 2026-10-25), so these assertions fail loudly if any offset
 * ever gets hardcoded. All inputs are epoch ms; none of this is money.
 */

const LABOR_DAY: CalendarOverride = { date: '2026-09-07', status: 'closed' };

const THANKSGIVING_FRIDAY: CalendarOverride = {
  date: '2026-11-27',
  status: 'early-close',
  // The vendor publishes explicit UTC instants for early-close days.
  openMs: Date.UTC(2026, 10, 27, 14, 30),
  closeMs: Date.UTC(2026, 10, 27, 18, 0),
};

describe('nyOffsetMinutes — DST derived, never hardcoded', () => {
  it('is −240 (EDT) in August and −300 (EST) in January', () => {
    expect(nyOffsetMinutes(Date.UTC(2026, 7, 10, 12, 0))).toBe(-240);
    expect(nyOffsetMinutes(Date.UTC(2026, 0, 12, 12, 0))).toBe(-300);
  });

  it('flips at the exact spring-forward instant, 2026-03-08 07:00Z', () => {
    expect(nyOffsetMinutes(Date.UTC(2026, 2, 8, 6, 59))).toBe(-300);
    expect(nyOffsetMinutes(Date.UTC(2026, 2, 8, 7, 1))).toBe(-240);
  });
});

describe('regularSessionFor — wall-clock sessions in UTC', () => {
  it('EDT regular day: 2026-08-10 opens 13:30Z and closes 20:00Z', () => {
    expect(regularSessionFor('2026-08-10', [])).toEqual({
      openMs: Date.UTC(2026, 7, 10, 13, 30),
      closeMs: Date.UTC(2026, 7, 10, 20, 0),
    });
  });

  it('EST regular day: 2026-01-12 closes 21:00Z', () => {
    expect(regularSessionFor('2026-01-12', [])?.closeMs).toBe(Date.UTC(2026, 0, 12, 21, 0));
  });

  it('weekends have no session', () => {
    expect(regularSessionFor('2026-08-08', [])).toBeNull(); // Saturday
    expect(regularSessionFor('2026-08-09', [])).toBeNull(); // Sunday
  });

  it('a full-closure override (Labor Day) has no session', () => {
    expect(regularSessionFor('2026-09-07', [LABOR_DAY])).toBeNull();
  });

  it('an early close uses the override’s explicit UTC close, not 16:00 ET', () => {
    const session = regularSessionFor('2026-11-27', [THANKSGIVING_FRIDAY]);
    expect(session?.closeMs).toBe(Date.UTC(2026, 10, 27, 18, 0));
    expect(session?.openMs).toBe(Date.UTC(2026, 10, 27, 14, 30));
  });

  it('an early close WITHOUT explicit instants still closes at 13:00 ET, never 16:00', () => {
    // The vendor sometimes omits the UTC instants on an early-close row. The
    // fallback must be the NYSE-standard 13:00 ET half-day close — falling
    // back to the full-session 16:00 would count down over a closed market
    // for three hours. 13:00 EST on 2026-11-27 = 18:00Z (DST-derived, so an
    // EDT half-day would land on 17:00Z instead — see the July case).
    const sansInstants: CalendarOverride = { date: '2026-11-27', status: 'early-close' };
    const session = regularSessionFor('2026-11-27', [sansInstants]);
    expect(session?.openMs).toBe(Date.UTC(2026, 10, 27, 14, 30));
    expect(session?.closeMs).toBe(Date.UTC(2026, 10, 27, 18, 0));
  });

  it('the instant-less 13:00 fallback is DST-derived: an EDT half-day closes 17:00Z', () => {
    // Thu 2026-07-02, a plausible pre-Independence-Day half-day, in EDT.
    const julyHalfDay: CalendarOverride = { date: '2026-07-02', status: 'early-close' };
    expect(regularSessionFor('2026-07-02', [julyHalfDay])?.closeMs).toBe(
      Date.UTC(2026, 6, 2, 17, 0),
    );
  });
});

describe('nextTransition — DST, holidays, weekends', () => {
  it('spring forward: Fri 2026-03-06 22:00Z → Mon open at 13:30Z, not 14:30Z', () => {
    expect(nextTransition(Date.UTC(2026, 2, 6, 22, 0), [])).toEqual({
      atMs: Date.UTC(2026, 2, 9, 13, 30),
      kind: 'open',
    });
  });

  it('fall back: Fri 2026-10-30 21:00Z → Mon 2026-11-02 open at 14:30Z, not 13:30Z', () => {
    expect(nextTransition(Date.UTC(2026, 9, 30, 21, 0), [])).toEqual({
      atMs: Date.UTC(2026, 10, 2, 14, 30),
      kind: 'open',
    });
  });

  it('holiday skip: Fri 2026-09-04 21:00Z with Labor Day closed → Tue 2026-09-08 13:30Z', () => {
    expect(nextTransition(Date.UTC(2026, 8, 4, 21, 0), [LABOR_DAY])).toEqual({
      atMs: Date.UTC(2026, 8, 8, 13, 30),
      kind: 'open',
    });
  });

  it('Saturday noon UTC → next open is Monday', () => {
    expect(nextTransition(Date.UTC(2026, 7, 8, 12, 0), [])).toEqual({
      atMs: Date.UTC(2026, 7, 10, 13, 30),
      kind: 'open',
    });
  });

  it('Friday 19:00Z while open → that day’s close', () => {
    expect(nextTransition(Date.UTC(2026, 7, 7, 19, 0), [])).toEqual({
      atMs: Date.UTC(2026, 7, 7, 20, 0),
      kind: 'close',
    });
  });

  it('pre-open on a trading day → that day’s open, not tomorrow’s', () => {
    // 2026-08-10 08:00Z is 04:00 ET — early session, next REGULAR boundary is
    // the 13:30Z open.
    expect(nextTransition(Date.UTC(2026, 7, 10, 8, 0), [])).toEqual({
      atMs: Date.UTC(2026, 7, 10, 13, 30),
      kind: 'open',
    });
  });
});

describe('statusAt — phases across one regular EDT day (2026-08-10)', () => {
  const at = (hourET: number) => Date.UTC(2026, 7, 10, hourET + 4, 0); // EDT = UTC−4

  it('03:00 ET closed, 05:00 ET early, 10:00 ET open, 17:00 ET late, 21:00 ET closed', () => {
    expect(statusAt(at(3), [])).toBe('closed');
    expect(statusAt(at(5), [])).toBe('early_trading');
    expect(statusAt(at(10), [])).toBe('open');
    expect(statusAt(at(17), [])).toBe('late_trading');
    expect(statusAt(at(21), [])).toBe('closed');
  });

  it('weekends are closed all day', () => {
    expect(statusAt(Date.UTC(2026, 7, 8, 15, 0), [])).toBe('closed');
  });

  it('an instant-less early close is NOT "open" mid-afternoon — late_trading from 13:00 ET', () => {
    const sansInstants: CalendarOverride = { date: '2026-11-27', status: 'early-close' };
    // 19:00Z = 14:00 EST — past the 13:00 half-day close. The pre-fix code
    // modeled this as a full session and reported "open" over a closed market.
    expect(statusAt(Date.UTC(2026, 10, 27, 19, 0), [sansInstants])).toBe('late_trading');
    // 17:30Z = 12:30 EST — still inside the shortened regular session.
    expect(statusAt(Date.UTC(2026, 10, 27, 17, 30), [sansInstants])).toBe('open');
    // 22:30Z = 17:30 EST — past close+4h (13:00 + 4 h = 17:00) — closed.
    expect(statusAt(Date.UTC(2026, 10, 27, 22, 30), [sansInstants])).toBe('closed');
  });

  it('the late session after an early close runs from the OVERRIDDEN close', () => {
    // 18:30Z on 2026-11-27 is past the 18:00Z early close but inside close+4h.
    expect(statusAt(Date.UTC(2026, 10, 27, 18, 30), [THANKSGIVING_FRIDAY])).toBe('late_trading');
    // 15:00Z is inside the shortened regular session.
    expect(statusAt(Date.UTC(2026, 10, 27, 15, 0), [THANKSGIVING_FRIDAY])).toBe('open');
    // 22:30Z is past close+4h — closed.
    expect(statusAt(Date.UTC(2026, 10, 27, 22, 30), [THANKSGIVING_FRIDAY])).toBe('closed');
  });
});

describe('nextSessionActivity — the poll-resume instant', () => {
  it('from a closed Saturday → Monday 04:00 ET as UTC (08:00Z in EDT)', () => {
    expect(nextSessionActivity(Date.UTC(2026, 7, 8, 12, 0), [])).toBe(Date.UTC(2026, 7, 10, 8, 0));
  });

  it('already inside the activity window → now itself', () => {
    const during = Date.UTC(2026, 7, 10, 14, 0);
    expect(nextSessionActivity(during, [])).toBe(during);
  });

  it('after the late close → the NEXT day’s 04:00 ET, skipping holidays', () => {
    // Fri 2026-09-04 21:00 ET (Sat 01:00Z) with Labor Day closed → Tue 08:00Z.
    expect(nextSessionActivity(Date.UTC(2026, 8, 5, 1, 0), [LABOR_DAY])).toBe(
      Date.UTC(2026, 8, 8, 8, 0),
    );
  });
});

describe('extendedAttribution — the persistent extended-hours line’s clock math', () => {
  // EDT reference week: Fri 2026-08-07 closes 20:00Z; late end +4 h = Sat 00:00Z.
  const FRIDAY_LATE_END = Date.UTC(2026, 7, 8, 0, 0);
  // A horizon predating every case — full coverage, no suppression.
  const FULL_COVERAGE = '2020-01-01';

  it('weekend → Friday’s late end, both Saturday and Sunday (EDT)', () => {
    expect(extendedAttribution(Date.UTC(2026, 7, 8, 12, 0), [], FULL_COVERAGE)).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: FRIDAY_LATE_END,
    });
    expect(extendedAttribution(Date.UTC(2026, 7, 9, 12, 0), [], FULL_COVERAGE)).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: FRIDAY_LATE_END,
    });
  });

  it('closed overnight after a trading day → that day’s late end (Tue 22:30 ET)', () => {
    // Tue 2026-08-11 22:30 ET = Wed 02:30Z; Tue’s late end 20:00 ET = Wed 00:00Z.
    expect(extendedAttribution(Date.UTC(2026, 7, 12, 2, 30), [], FULL_COVERAGE)).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: Date.UTC(2026, 7, 12, 0, 0),
    });
  });

  it('before 04:00 ET on a trading day → the PREVIOUS session’s late end (Mon 02:00 ET → Friday)', () => {
    expect(extendedAttribution(Date.UTC(2026, 7, 10, 6, 0), [], FULL_COVERAGE)).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: FRIDAY_LATE_END,
    });
  });

  it('a holiday closure attributes to the last trading day before it', () => {
    // Labor Day Monday noon ET → Fri 2026-09-04’s late end (Sat 00:00Z).
    expect(extendedAttribution(Date.UTC(2026, 8, 7, 16, 0), [LABOR_DAY], FULL_COVERAGE)).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: Date.UTC(2026, 8, 5, 0, 0),
    });
  });

  it('an early-close day’s late session ends close + 4 h — 22:00Z, never midnight', () => {
    // Thanksgiving Friday closes 18:00Z (13:00 EST); +4 h = 22:00Z (17:00 ET).
    expect(
      extendedAttribution(Date.UTC(2026, 10, 28, 12, 0), [THANKSGIVING_FRIDAY], FULL_COVERAGE),
    ).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: Date.UTC(2026, 10, 27, 22, 0),
    });
  });

  it('EST overnight: Mon 2026-01-12 closes 21:00Z, late end Tue 01:00Z — DST-derived', () => {
    expect(extendedAttribution(Date.UTC(2026, 0, 13, 2, 0), [], FULL_COVERAGE)).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: Date.UTC(2026, 0, 13, 1, 0),
    });
  });

  it('mid-early-session → early with NO instant: the session has not ended yet', () => {
    // 2026-08-10 05:00 ET (09:00Z) — never a future or invented instant.
    expect(extendedAttribution(Date.UTC(2026, 7, 10, 9, 0), [], FULL_COVERAGE)).toEqual({
      kind: 'early',
      live: true,
      endedAtMs: null,
    });
  });

  it('mid-late-session → late with NO instant', () => {
    // 2026-08-10 17:00 ET (21:00Z).
    expect(extendedAttribution(Date.UTC(2026, 7, 10, 21, 0), [], FULL_COVERAGE)).toEqual({
      kind: 'late',
      live: true,
      endedAtMs: null,
    });
  });

  it('mid-regular-session (the vendor-halt corner) → early, ended at the open', () => {
    // 2026-08-10 11:00 ET (15:00Z): the most recent extended session that
    // has STARTED is the early one, and it ended at the 13:30Z open.
    expect(extendedAttribution(Date.UTC(2026, 7, 10, 15, 0), [], FULL_COVERAGE)).toEqual({
      kind: 'early',
      live: false,
      endedAtMs: Date.UTC(2026, 7, 10, 13, 30),
    });
  });

  it('an unbroken closure streak past the scan bound → null, never an invented session', () => {
    const closures: CalendarOverride[] = [];
    for (let d = 28; d <= 31; d++) {
      closures.push({ date: `2026-07-${d}`, status: 'closed' });
    }
    for (let d = 1; d <= 14; d++) {
      closures.push({ date: `2026-08-${String(d).padStart(2, '0')}`, status: 'closed' });
    }
    expect(extendedAttribution(Date.UTC(2026, 7, 14, 12, 0), closures, FULL_COVERAGE)).toBeNull();
  });

  it('an attributed date BEFORE the coverage horizon → kind kept, instant suppressed', () => {
    // Saturday noon attributes to Friday 2026-08-07, but coverage only began
    // on the 8th — the calendar cannot vouch that the 7th really traded, so
    // the honest label is the session name with no time.
    expect(extendedAttribution(Date.UTC(2026, 7, 8, 12, 0), [], '2026-08-08')).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: null,
    });
  });

  it('a null horizon (no coverage row yet) suppresses every instant', () => {
    expect(extendedAttribution(Date.UTC(2026, 7, 8, 12, 0), [], null)).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: null,
    });
    // The mid-regular corner too: kind early survives, the open instant does not.
    expect(extendedAttribution(Date.UTC(2026, 7, 10, 15, 0), [], null)).toEqual({
      kind: 'early',
      live: false,
      endedAtMs: null,
    });
  });

  it('on or after the horizon the instant is unchanged', () => {
    expect(extendedAttribution(Date.UTC(2026, 7, 8, 12, 0), [], '2026-08-07')).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: FRIDAY_LATE_END,
    });
  });

  it('a LIVE late window and an ended-but-unvouched late session are DIFFERENT results', () => {
    // Both suppress the instant — but liveness is its own fact, so a reading
    // from a session that ended hours ago can never render as a live one.
    expect(extendedAttribution(Date.UTC(2026, 7, 10, 21, 0), [], FULL_COVERAGE)).toEqual({
      kind: 'late',
      live: true,
      endedAtMs: null,
    });
    expect(extendedAttribution(Date.UTC(2026, 7, 8, 12, 0), [], null)).toEqual({
      kind: 'late',
      live: false,
      endedAtMs: null,
    });
  });

  it('the early twin: a LIVE early window vs an ended-but-unvouched early session', () => {
    // Mon 2026-08-10 05:00 ET — mid-early-window, live.
    expect(extendedAttribution(Date.UTC(2026, 7, 10, 9, 0), [], FULL_COVERAGE)).toEqual({
      kind: 'early',
      live: true,
      endedAtMs: null,
    });
    // Mon 11:00 ET (mid-regular, the halt corner) with no horizon: the early
    // session HAS ended at the open — unvouched instant, but never live.
    expect(extendedAttribution(Date.UTC(2026, 7, 10, 15, 0), [], null)).toEqual({
      kind: 'early',
      live: false,
      endedAtMs: null,
    });
  });
});

describe('nyDateISOAt', () => {
  it('rolls the NY calendar date at midnight ET, not midnight UTC', () => {
    // 03:00Z on Aug 11 is still 23:00 ET on Aug 10.
    expect(nyDateISOAt(Date.UTC(2026, 7, 11, 3, 0))).toBe('2026-08-10');
    expect(nyDateISOAt(Date.UTC(2026, 7, 11, 5, 0))).toBe('2026-08-11');
  });
});

describe('recentSessionDatesISO — the calendar the trend strip marks on', () => {
  // The regular EDT close is 16:00 ET = 20:00Z; 21:00Z is safely past it.
  const AFTER_FRIDAY_CLOSE = Date.UTC(2026, 7, 21, 21, 0);

  it('walks back over the weekend, oldest first', () => {
    expect(recentSessionDatesISO(5, AFTER_FRIDAY_CLOSE, [])).toEqual([
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
    ]);
  });

  it('excludes a session that has not finished yet', () => {
    // 17:00Z is 13:00 ET — the market is open, so today has no final close to
    // record and the right edge is yesterday.
    const midSession = Date.UTC(2026, 7, 21, 17, 0);
    const dates = recentSessionDatesISO(5, midSession, []);
    expect(dates.at(-1)).toBe('2026-08-20');
    expect(dates).toEqual(['2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20']);
  });

  it('skips a holiday it is told about', () => {
    // Labor Day, Monday 2026-09-07. The scan reaches back past it to the
    // preceding Friday rather than returning four real sessions and a closure.
    const afterClose = Date.UTC(2026, 8, 11, 21, 0);
    expect(recentSessionDatesISO(5, afterClose, [LABOR_DAY])).toEqual([
      '2026-09-04',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
    ]);
  });

  it('counts a holiday as a session when the overrides are withheld', () => {
    // Not a feature — the documented cost of passing `[]`, pinned so that the
    // requirement in the doc comment is a tested claim rather than advice.
    expect(recentSessionDatesISO(5, Date.UTC(2026, 8, 11, 21, 0), [])).toContain('2026-09-07');
  });

  it('asks for nothing and gets nothing', () => {
    expect(recentSessionDatesISO(0, AFTER_FRIDAY_CLOSE, [])).toEqual([]);
    expect(recentSessionDatesISO(-1, AFTER_FRIDAY_CLOSE, [])).toEqual([]);
  });

  it('returns exactly the number of sessions asked for', () => {
    expect(recentSessionDatesISO(1, AFTER_FRIDAY_CLOSE, [])).toEqual(['2026-08-21']);
    expect(recentSessionDatesISO(6, AFTER_FRIDAY_CLOSE, [])).toHaveLength(6);
  });
});
