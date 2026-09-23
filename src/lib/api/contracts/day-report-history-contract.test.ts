import { describe, expect, it } from 'vitest';

import { composeDayReportHistory } from '@/lib/day-report/history-compose';

import { dayReportHistoryQuerySchema, dayReportHistoryResponseSchema } from './day-report';

describe('dayReportHistoryResponseSchema', () => {
  it('accepts the real composer output, including a null-figure and a partial row', () => {
    const composed = composeDayReportHistory(
      [
        { day: '2026-09-19', kind: 'close', status: 'ready', figureDay: '2026-09-19', dayChangePln: '1234.56', dayChangePct: '0.84', figurePartial: true },
        { day: '2026-09-19', kind: 'morning', status: 'refused', figureDay: '2026-09-18', dayChangePln: '-5', dayChangePct: '-0.01', figurePartial: false },
        { day: '2026-09-18', kind: 'close', status: 'ready', figureDay: null, dayChangePln: null, dayChangePct: null, figurePartial: false },
      ],
      { todayNY: '2026-09-20' },
    );
    const parsed = dayReportHistoryResponseSchema.parse(composed);
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items[0]?.partial).toBe(true);
    expect(parsed.items[1]?.narrativeStatus).toBe('refused');
    expect(parsed.items[2]?.dayChange).toBeNull();
    expect(parsed.nextCursor).toBeNull();
  });

  it('accepts a page with a cursor', () => {
    const parsed = dayReportHistoryResponseSchema.parse({ items: [], nextCursor: '2026-09-01:close' });
    expect(parsed.nextCursor).toBe('2026-09-01:close');
  });
});

describe('dayReportHistoryQuerySchema', () => {
  it('accepts an absent or well-formed cursor and rejects a malformed one', () => {
    expect(dayReportHistoryQuerySchema.safeParse({}).success).toBe(true);
    expect(dayReportHistoryQuerySchema.safeParse({ cursor: '2026-09-01:morning' }).success).toBe(true);
    expect(dayReportHistoryQuerySchema.safeParse({ cursor: '2026-09-01' }).success).toBe(false);
    expect(dayReportHistoryQuerySchema.safeParse({ cursor: '2026-09-01:noon' }).success).toBe(false);
  });
});
