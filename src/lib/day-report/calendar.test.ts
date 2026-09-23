import { describe, expect, it } from 'vitest';

import { adjacentSessionDays, dayReportBounds, isReportableDay, segmentAvailability } from './calendar';

const bounds = { earliest: '2026-09-01', latest: '2026-09-08' };

describe('day report calendar', () => {
  it('steps Friday to Monday', () => expect(adjacentSessionDays('2026-09-04', bounds, []).next).toBe('2026-09-07'));
  it('steps Monday to Friday', () => expect(adjacentSessionDays('2026-09-07', bounds, []).prev).toBe('2026-09-04'));
  it('skips a holiday override', () => expect(adjacentSessionDays('2026-09-04', bounds, [{ date: '2026-09-07', status: 'closed' }]).next).toBe('2026-09-08'));
  it('accepts an early-close session', () => expect(isReportableDay('2026-09-04', bounds, [{ date: '2026-09-04', status: 'early-close' }])).toBe(true));
  it('rejects Saturday', () => expect(isReportableDay('2026-09-05', bounds, [])).toBe(false));
  it('clamps the previous edge', () => expect(adjacentSessionDays('2026-09-01', bounds, []).prev).toBeNull());
  it('marks close market-open before the bell', () => expect(segmentAvailability('2026-09-04', Date.UTC(2026, 8, 4, 15), []).close).toBe('market_open'));
  it('keeps the morning half ready after the open, same day', () => expect(segmentAvailability('2026-09-04', Date.UTC(2026, 8, 4, 15), []).morning).toBe('ready'));
  it('keeps the morning half ready after the close, same day', () => expect(segmentAvailability('2026-09-04', Date.UTC(2026, 8, 4, 21), []).morning).toBe('ready'));
  it('has no morning half for a future day', () => expect(segmentAvailability('2026-09-08', Date.UTC(2026, 8, 4, 15), []).morning).toBe('none'));
  it('includes today in bounds before close', () => expect(dayReportBounds({ nowMs: Date.UTC(2026, 8, 4, 12, 30), overrides: [], firstTradeDate: '2026-09-01' })?.latest).toBe('2026-09-04'));
});
