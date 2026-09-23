import { describe, expect, it, vi } from 'vitest';

import { signedMoney } from '@/lib/holdings/live-payload';
import { dec } from '@/lib/money';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: {}, dayReports: {} }));

import { HISTORY_PAGE_SIZE, type DayReportHistoryRow } from './history-compose';
import { listDayReportHistory, type HistoryDependencies } from './history';

function harness(rows: DayReportHistoryRow[] = []) {
  const select = vi.fn<HistoryDependencies['select']>(async () => rows);
  const dependencies: HistoryDependencies = {
    select,
    nowMs: () => Date.UTC(2026, 8, 20, 12),
  };
  return { select, dependencies };
}

describe('listDayReportHistory', () => {
  it('asks for one row more than a page, for the caller only, with no cursor on page one', async () => {
    const { select, dependencies } = harness();
    await listDayReportHistory('user-1', undefined, dependencies);
    expect(select).toHaveBeenCalledWith('user-1', null, HISTORY_PAGE_SIZE + 1);
  });

  it('forwards a parsed cursor to the query', async () => {
    const { select, dependencies } = harness();
    await listDayReportHistory('user-1', '2026-09-01:morning', dependencies);
    expect(select).toHaveBeenCalledWith('user-1', { day: '2026-09-01', kind: 'morning' }, HISTORY_PAGE_SIZE + 1);
  });

  it('composes the selected rows with the NY calendar day as today', async () => {
    const { dependencies } = harness([
      { day: '2026-09-18', kind: 'close', status: 'ready', figureDay: '2026-09-18', dayChangePln: '10', dayChangePct: '1', figurePartial: false },
    ]);
    const result = await listDayReportHistory('user-1', undefined, dependencies);
    expect(result.items[0]?.dayLabel).toBe('Fri 18 Sep');
    expect(result.items[0]?.dayChange?.text).toBe(signedMoney(dec('10'), 'PLN'));
    expect(result.nextCursor).toBeNull();
  });
});
