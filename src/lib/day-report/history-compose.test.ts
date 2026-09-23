import { describe, expect, it } from 'vitest';

import { signedMoney } from '@/lib/holdings/live-payload';
import { dec } from '@/lib/money';

import {
  composeDayReportHistory,
  formatHistoryCursor,
  HISTORY_PAGE_SIZE,
  parseHistoryCursor,
  shortDayLabel,
  type DayReportHistoryRow,
} from './history-compose';

const TODAY = '2026-09-20';

function row(overrides: Partial<DayReportHistoryRow> = {}): DayReportHistoryRow {
  return {
    day: '2026-09-19',
    kind: 'close',
    status: 'ready',
    figureDay: '2026-09-19',
    dayChangePln: '1234.56',
    dayChangePct: '0.84',
    figurePartial: false,
    ...overrides,
  };
}

/** `count` rows walking back one day per row, newest first, alternating close/morning within a day. */
function rows(count: number): DayReportHistoryRow[] {
  const out: DayReportHistoryRow[] = [];
  let day = 19;
  while (out.length < count) {
    const iso = `2026-09-${String(day).padStart(2, '0')}`;
    out.push(row({ day: iso, kind: 'close' }));
    if (out.length < count) out.push(row({ day: iso, kind: 'morning', figureDay: `2026-09-${String(day - 1).padStart(2, '0')}` }));
    day -= 1;
  }
  return out;
}

describe('composeDayReportHistory', () => {
  it('preserves the selected order — close before morning on one day, newest first', () => {
    const input = [
      row({ day: '2026-09-19', kind: 'close' }),
      row({ day: '2026-09-19', kind: 'morning', figureDay: '2026-09-18' }),
      row({ day: '2026-09-18', kind: 'close' }),
    ];
    const result = composeDayReportHistory(input, { todayNY: TODAY });
    expect(result.items.map((item) => `${item.day}:${item.kind}`)).toEqual([
      '2026-09-19:close', '2026-09-19:morning', '2026-09-18:close',
    ]);
  });

  it('emits a page of 30 and a cursor from the 30th when a 31st row was present', () => {
    const input = rows(HISTORY_PAGE_SIZE + 1);
    const result = composeDayReportHistory(input, { todayNY: TODAY });
    expect(result.items).toHaveLength(30);
    const last = input[29] as DayReportHistoryRow;
    expect(result.nextCursor).toBe(`${last.day}:${last.kind}`);
    expect(result.items.some((item) => item.day === (input[30] as DayReportHistoryRow).day && item.kind === (input[30] as DayReportHistoryRow).kind)).toBe(false);
  });

  it('answers a null cursor when exactly a page was selected', () => {
    const result = composeDayReportHistory(rows(HISTORY_PAGE_SIZE), { todayNY: TODAY });
    expect(result.items).toHaveLength(30);
    expect(result.nextCursor).toBeNull();
  });

  it('answers a null cursor and no items for no rows', () => {
    const result = composeDayReportHistory([], { todayNY: TODAY });
    expect(result).toEqual({ items: [], nextCursor: null });
  });

  it('renders a missing stored figure as null — never a zero', () => {
    const [item] = composeDayReportHistory(
      [row({ figureDay: null, dayChangePln: null, dayChangePct: null })],
      { todayNY: TODAY },
    ).items;
    expect(item?.dayChange).toBeNull();
    expect(item?.dayChangePct).toBeNull();
    expect(item?.figureDay).toBeNull();
    expect(item?.figureDayLabel).toBeNull();
    expect(JSON.stringify(item)).not.toContain('0,00');
  });

  it('formats a gain and a loss through signedMoney with the matching direction', () => {
    const items = composeDayReportHistory(
      [
        row({ day: '2026-09-19', dayChangePln: '1234.56', dayChangePct: '0.84' }),
        row({ day: '2026-09-18', dayChangePln: '-98.7', dayChangePct: '-0.12' }),
      ],
      { todayNY: TODAY },
    ).items;
    // The exact formatter output (Intl's grouping uses non-breaking spaces).
    expect(items[0]?.dayChange).toEqual({ text: signedMoney(dec('1234.56'), 'PLN'), direction: 'gain' });
    expect(items[0]?.dayChange?.text.startsWith('+1')).toBe(true);
    expect(items[0]?.dayChangePct).toBe('+0,84%');
    expect(items[1]?.dayChange).toEqual({ text: signedMoney(dec('-98.7'), 'PLN'), direction: 'loss' });
    expect(items[1]?.dayChangePct).toBe('-0,12%');
  });

  it('carries partial and the refused narrative status through', () => {
    const [item] = composeDayReportHistory(
      [row({ figurePartial: true, status: 'refused' })],
      { todayNY: TODAY },
    ).items;
    expect(item?.partial).toBe(true);
    expect(item?.narrativeStatus).toBe('refused');
  });

  it('labels a morning row with the previous session it recaps', () => {
    const [item] = composeDayReportHistory(
      [row({ day: '2026-09-18', kind: 'morning', figureDay: '2026-09-17' })],
      { todayNY: TODAY },
    ).items;
    expect(item?.dayLabel).toBe('Fri 18 Sep');
    expect(item?.figureDayLabel).toBe('Thu 17 Sep');
  });
});

describe('shortDayLabel', () => {
  it('appends the year only across a year boundary', () => {
    expect(shortDayLabel('2026-09-18', '2026-09-20')).toBe('Fri 18 Sep');
    expect(shortDayLabel('2026-09-19', '2026-09-20')).toBe('Sat 19 Sep');
    expect(shortDayLabel('2025-12-31', '2026-01-02')).toBe('Wed 31 Dec 2025');
    expect(shortDayLabel('2026-01-02', '2026-01-02')).toBe('Fri 2 Jan');
  });
});

describe('history cursor', () => {
  it('round-trips through format and parse', () => {
    const cursor = formatHistoryCursor('2026-09-01', 'morning');
    expect(cursor).toBe('2026-09-01:morning');
    expect(parseHistoryCursor(cursor)).toEqual({ day: '2026-09-01', kind: 'morning' });
  });

  it('rejects a malformed cursor', () => {
    expect(parseHistoryCursor('2026-09-01')).toBeNull();
    expect(parseHistoryCursor('2026-09-01:noon')).toBeNull();
    expect(parseHistoryCursor('yesterday:close')).toBeNull();
    expect(parseHistoryCursor('')).toBeNull();
    expect(parseHistoryCursor(undefined)).toBeNull();
  });
});
