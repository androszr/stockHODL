import { describe, expect, it } from 'vitest';

import type { PortfolioSummary } from '@/lib/holdings/summary';
import type { CalendarOverride } from '@/lib/market-data/market-clock';
import { dec } from '@/lib/money';

import {
  composeDailySummaryAlert,
  dailySummaryDayToSend,
  morningBriefDayToSend,
} from './daily-summary';

const DAY = '2026-09-04';

/** A fully-priced, fully-day-covered summary — the happy path baseline. */
function summary(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    totalValuePLN: dec('100000'),
    dayChangePLN: dec('1234.56'),
    dayChangePct: dec('0.84'),
    totalChangePLN: dec('5000'),
    totalChangePct: dec('5.26'),
    excludedSymbols: [],
    partialDayChange: false,
    ...overrides,
  };
}

function alert(overrides: Partial<PortfolioSummary> = {}) {
  return composeDailySummaryAlert(summary(overrides), DAY);
}

describe('composeDailySummaryAlert', () => {
  it('formats a gain in pl-PL with grouping on a four-digit amount', () => {
    const result = alert();
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Portfolio today');
    // Both separators are U+00A0 (escapes, not literal spaces — see money.test.ts).
    expect(result!.body).toBe('+1\u00a0234,56\u00a0zł (+0,84%)');
  });

  it('formats a loss without double-signing', () => {
    expect(alert({ dayChangePLN: dec('-321.07'), dayChangePct: dec('-1.2') })!.body).toBe(
      '-321,07\u00a0zł (-1,20%)',
    );
  });

  it('leaves an exactly-flat day unsigned', () => {
    expect(alert({ dayChangePLN: dec('0'), dayChangePct: dec('0') })!.body).toBe(
      '0,00\u00a0zł (0,00%)',
    );
  });

  it('says "At least" when the day figure is a floor', () => {
    expect(alert({ partialDayChange: true })!.body).toBe(
      'At least +1\u00a0234,56\u00a0zł (+0,84%)',
    );
  });

  it('names excluded symbols on a second line, never a count', () => {
    expect(alert({ excludedSymbols: ['AAPL', 'MSFT'] })!.body).toBe(
      '+1\u00a0234,56\u00a0zł (+0,84%)\nWithout: AAPL, MSFT',
    );
  });

  it('drops the percent when there is no prior-day base to compute it from', () => {
    expect(alert({ dayChangePLN: dec('123.45'), dayChangePct: null })!.body).toBe(
      '+123,45\u00a0zł',
    );
  });

  it('sends nothing at all when no day figure exists', () => {
    expect(
      alert({ dayChangePLN: null, dayChangePct: null }),
    ).toBeNull();
  });

  it('deep-links to the close report', () => {
    expect(alert()!.urlScheme).toBe('stockhodl://day-report/2026-09-04?kind=close');
  });
});

describe('morningBriefDayToSend', () => {
  it('returns today before a session opens', () => {
    expect(morningBriefDayToSend(Date.UTC(2026, 8, 4, 12, 30), [])).toBe(DAY);
  });

  it('returns null after the open', () => {
    expect(morningBriefDayToSend(Date.UTC(2026, 8, 4, 14, 0), [])).toBeNull();
  });

  it('returns null on Saturday', () => {
    expect(morningBriefDayToSend(Date.UTC(2026, 8, 5, 12, 30), [])).toBeNull();
  });

  it('returns null on a closed override', () => {
    expect(
      morningBriefDayToSend(Date.UTC(2026, 8, 4, 12, 30), [{ date: DAY, status: 'closed' }]),
    ).toBeNull();
  });

  it('returns an early-close day before its unchanged open', () => {
    expect(
      morningBriefDayToSend(Date.UTC(2026, 8, 4, 12, 30), [
        { date: DAY, status: 'early-close' },
      ]),
    ).toBe(DAY);
  });
});

describe('dailySummaryDayToSend', () => {
  // Friday 2026-09-04 — a plain US trading day. 21:15 UTC is 17:15 EDT,
  // after the 16:00 close.
  const friAfterClose = Date.UTC(2026, 8, 4, 21, 15);

  it('returns the NY date on a trading weekday after the close', () => {
    expect(dailySummaryDayToSend(friAfterClose, [])).toBe('2026-09-04');
  });

  it('returns null while the session is still running', () => {
    // 15:00 UTC is 11:00 EDT — mid-session, no completed close yet today.
    expect(dailySummaryDayToSend(Date.UTC(2026, 8, 4, 15, 0), [])).toBeNull();
  });

  it('returns null on a weekend', () => {
    // Saturday 2026-09-05: the last completed session is Friday, not today.
    expect(dailySummaryDayToSend(Date.UTC(2026, 8, 5, 21, 15), [])).toBeNull();
  });

  it('returns null on a market holiday', () => {
    const holiday: CalendarOverride[] = [{ date: '2026-09-04', status: 'closed' }];
    expect(dailySummaryDayToSend(friAfterClose, holiday)).toBeNull();
  });

  it('still sends on an early-close day once the early close has passed', () => {
    const earlyClose: CalendarOverride[] = [{ date: '2026-09-04', status: 'early-close' }];
    // 18:00 UTC is 14:00 EDT — past the NYSE-standard 13:00 early close,
    // before the regular 16:00 close that no longer applies.
    expect(dailySummaryDayToSend(Date.UTC(2026, 8, 4, 18, 0), earlyClose)).toBe('2026-09-04');
  });
});
