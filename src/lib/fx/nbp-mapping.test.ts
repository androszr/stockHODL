import { describe, expect, it } from 'vitest';

import {
  addDaysIso,
  carryForwardRates,
  d1Window,
  isPendingPublication,
  lastWeekdayBefore,
  mapNbpRates,
  NBP_FIRST_DATE,
  nbpRatesResponseSchema,
  splitDateRange,
} from './nbp-mapping';

/**
 * Hermetic — no network. The date rule (D-1: last business day strictly
 * before the trade date) and the number→decimal-string money boundary are the
 * two things this ship must never get wrong.
 */

describe('lastWeekdayBefore', () => {
  it.each([
    // [trade date, expected last weekday strictly before]
    ['2026-08-04', '2026-08-03'], // Tuesday → Monday
    ['2026-08-03', '2026-07-31'], // Monday → previous Friday, over the weekend
    ['2026-08-08', '2026-08-07'], // Saturday trade date → Friday
    ['2026-08-09', '2026-08-07'], // Sunday trade date → Friday
    ['2026-01-01', '2025-12-31'], // year boundary (Thu → Wed)
    ['2024-03-01', '2024-02-29'], // leap day: Friday → leap Thursday
  ])('%s → %s', (tradeDate, expected) => {
    expect(lastWeekdayBefore(tradeDate)).toBe(expected);
  });

  it('never returns the trade date itself, even from a Monday', () => {
    // Strictly before: the rule is D-1, not "most recent including D".
    expect(lastWeekdayBefore('2026-08-03')).not.toBe('2026-08-03');
  });
});

describe('addDaysIso', () => {
  it.each([
    ['2026-08-05', -14, '2026-07-22'], // −14 across a month boundary
    ['2026-01-07', -14, '2025-12-24'], // −14 across a year boundary
    ['2024-02-28', 1, '2024-02-29'], // forward onto a leap day
    ['2026-02-28', 1, '2026-03-01'], // forward over a non-leap February
    ['2026-03-15', 0, '2026-03-15'], // identity
  ])('%s %+d days → %s', (iso, delta, expected) => {
    expect(addDaysIso(iso, delta)).toBe(expected);
  });
});

describe('d1Window', () => {
  it('ends strictly before the trade date and reaches 14 days back', () => {
    expect(d1Window('2026-08-04')).toEqual({ from: '2026-07-21', to: '2026-08-03' });
  });

  it('covers the Easter cluster for the Tuesday after Easter Monday', () => {
    // Easter Monday 2026 is April 6. A trade on Tuesday the 7th must still
    // have published days inside the window despite Fri–Mon being closed.
    expect(d1Window('2026-04-07')).toEqual({ from: '2026-03-24', to: '2026-04-06' });
  });

  it('covers the Christmas cluster for a Dec 28 trade', () => {
    expect(d1Window('2026-12-28')).toEqual({ from: '2026-12-14', to: '2026-12-27' });
  });

  it('spans a year boundary without drifting', () => {
    expect(d1Window('2027-01-04')).toEqual({ from: '2026-12-21', to: '2027-01-03' });
  });
});

describe('isPendingPublication — the pre-12:15 gap', () => {
  // All "today" values are injected — hermetic, no real clock. 2026-08-10 is a
  // Monday; 2026-08-08/09 are Saturday/Sunday; 2026-01-01 (Thursday) is a
  // Polish holiday.

  it('flags a window ending TODAY (weekday) whose newest row is yesterday', () => {
    // Trade date = tomorrow, looked up before NBP publishes (~12:15 CET):
    // yesterday's rate would look correct but is WRONG — must not be `ok`.
    expect(
      isPendingPublication({
        to: '2026-08-10',
        todayWarsaw: '2026-08-10',
        lastEffectiveDate: '2026-08-07',
      }),
    ).toBe(true);
  });

  it("does not flag once today's rate is actually in the response", () => {
    expect(
      isPendingPublication({
        to: '2026-08-10',
        todayWarsaw: '2026-08-10',
        lastEffectiveDate: '2026-08-10',
      }),
    ).toBe(false);
  });

  it('does not flag a window ending strictly in the past', () => {
    expect(
      isPendingPublication({
        to: '2026-08-07',
        todayWarsaw: '2026-08-10',
        lastEffectiveDate: '2026-08-07',
      }),
    ).toBe(false);
  });

  it.each([
    ['2026-08-08'], // Saturday
    ['2026-08-09'], // Sunday
  ])('does not flag when today (%s) is a weekend — nothing can publish', (day) => {
    // Trade date = tomorrow with today a weekend: to = today, but NBP never
    // publishes on weekends, so Friday's rate is final and genuinely D-1.
    expect(
      isPendingPublication({
        to: day,
        todayWarsaw: day,
        lastEffectiveDate: '2026-08-07',
      }),
    ).toBe(false);
  });

  it('is conservative when today is a weekday holiday (documented trade-off)', () => {
    // 2026-01-01 is a Thursday and a holiday: no rate for it will ever exist,
    // so `not_published` is merely cautious — the right direction for money.
    expect(
      isPendingPublication({
        to: '2026-01-01',
        todayWarsaw: '2026-01-01',
        lastEffectiveDate: '2025-12-31',
      }),
    ).toBe(true);
  });
});

describe('NBP_FIRST_DATE', () => {
  it('is the documented start of the NBP API data', () => {
    expect(NBP_FIRST_DATE).toBe('2002-01-02');
  });
});

describe('mapNbpRates — the money boundary', () => {
  it('converts a fractional mid via shortest round-trip, no trailing zeros', () => {
    const rows = mapNbpRates({ rates: [{ effectiveDate: '2026-08-07', mid: 3.7324 }] });
    expect(rows).toEqual([{ effectiveDate: '2026-08-07', rate: '3.7324' }]);
  });

  it('keeps an integer mid as a bare integer string', () => {
    const rows = mapNbpRates({ rates: [{ effectiveDate: '2026-08-07', mid: 4 }] });
    expect(rows).toEqual([{ effectiveDate: '2026-08-07', rate: '4' }]);
  });

  it('drops an entry missing mid without failing the rest', () => {
    const rows = mapNbpRates({
      rates: [
        { effectiveDate: '2026-08-06' },
        { effectiveDate: '2026-08-07', mid: 3.7324 },
      ],
    });
    expect(rows).toEqual([{ effectiveDate: '2026-08-07', rate: '3.7324' }]);
  });

  it('drops an entry missing effectiveDate without failing the rest', () => {
    const rows = mapNbpRates({
      rates: [{ mid: 3.7 }, { effectiveDate: '2026-08-07', mid: 3.7324 }],
    });
    expect(rows).toEqual([{ effectiveDate: '2026-08-07', rate: '3.7324' }]);
  });

  it('preserves ascending order — the last element is the D-1 rate', () => {
    const rows = mapNbpRates({
      rates: [
        { effectiveDate: '2026-08-05', mid: 3.71 },
        { effectiveDate: '2026-08-06', mid: 3.72 },
        { effectiveDate: '2026-08-07', mid: 3.7324 },
      ],
    });
    expect(rows.map((r) => r.effectiveDate)).toEqual([
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
    ]);
    expect(rows[rows.length - 1].rate).toBe('3.7324');
  });

  it('maps an empty rates array to []', () => {
    expect(mapNbpRates({ rates: [] })).toEqual([]);
    expect(mapNbpRates({})).toEqual([]);
  });

  it('parses the real probed payload shape end to end', () => {
    // Verbatim shape from the live probe of 2026-08-09 — unknown extras
    // (`table`, `code`, `no`) must pass the loose schema untouched.
    const payload = {
      table: 'A',
      currency: 'dolar amerykański',
      code: 'USD',
      rates: [{ no: '152/A/NBP/2026', effectiveDate: '2026-08-07', mid: 3.7324 }],
    };
    const parsed = nbpRatesResponseSchema.parse(payload);
    expect(mapNbpRates(parsed)).toEqual([
      { effectiveDate: '2026-08-07', rate: '3.7324' },
    ]);
  });
});

describe('splitDateRange — the 367-day NBP request limit', () => {
  it('keeps a short range as one chunk', () => {
    expect(splitDateRange('2026-07-01', '2026-08-10')).toEqual([
      { from: '2026-07-01', to: '2026-08-10' },
    ]);
  });

  it('splits a 5-year range into consecutive, non-overlapping chunks', () => {
    const chunks = splitDateRange('2021-08-11', '2026-08-11', 360);
    expect(chunks.length).toBe(6);
    expect(chunks[0].from).toBe('2021-08-11');
    expect(chunks[chunks.length - 1].to).toBe('2026-08-11');
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].from).toBe(addDaysIso(chunks[i - 1].to, 1));
    }
  });

  it('a single day is one single-day chunk; an inverted range yields none', () => {
    expect(splitDateRange('2026-08-11', '2026-08-11')).toEqual([
      { from: '2026-08-11', to: '2026-08-11' },
    ]);
    expect(splitDateRange('2026-08-11', '2026-08-10')).toEqual([]);
  });
});

describe('carryForwardRates — dense per-day series with D-1 semantics', () => {
  // Fri 2026-08-07 and Mon 2026-08-10 are published; the weekend is not.
  const rows = [
    { effectiveDate: '2026-08-07', rate: '3.7324' },
    { effectiveDate: '2026-08-10', rate: '3.74' },
  ];

  it('weekend days inherit the prior business day rate', () => {
    const dense = carryForwardRates(rows, '2026-08-07', '2026-08-10');
    expect(dense.get('2026-08-07')).toBe('3.7324');
    expect(dense.get('2026-08-08')).toBe('3.7324'); // Saturday
    expect(dense.get('2026-08-09')).toBe('3.7324'); // Sunday
    expect(dense.get('2026-08-10')).toBe('3.74');
  });

  it('seeds from a published rate before the window start', () => {
    const dense = carryForwardRates(rows, '2026-08-08', '2026-08-09');
    expect(dense.get('2026-08-08')).toBe('3.7324');
    expect(dense.get('2026-08-09')).toBe('3.7324');
  });

  it('days before the first published rate stay absent — never a fake seed', () => {
    const dense = carryForwardRates(rows, '2026-08-05', '2026-08-07');
    expect(dense.has('2026-08-05')).toBe(false);
    expect(dense.has('2026-08-06')).toBe(false);
    expect(dense.get('2026-08-07')).toBe('3.7324');
  });

  it('tolerates unsorted input rows', () => {
    const dense = carryForwardRates([rows[1], rows[0]], '2026-08-07', '2026-08-10');
    expect(dense.get('2026-08-09')).toBe('3.7324');
    expect(dense.get('2026-08-10')).toBe('3.74');
  });
});
