import { describe, expect, it } from 'vitest';

import { dayReportIsComplete, dayReportPushMayGo } from './readiness';
import type { DayReportNarrativeResponse } from './view-types';

function narrative(status: DayReportNarrativeResponse['status']): DayReportNarrativeResponse {
  return {
    status,
    portfolioNarrative: null,
    eventsNarrative: null,
    macroNarrative: null,
    events: [],
    todayLine: null,
    sources: [],
    staleFigures: false,
  };
}

describe('dayReportIsComplete', () => {
  it('a ready report is complete', () => {
    expect(dayReportIsComplete(narrative('ready'))).toBe(true);
  });

  it('a refused report is complete (the writer declined; terminal for the day)', () => {
    expect(dayReportIsComplete(narrative('refused'))).toBe(true);
  });

  it('a pending report (a reservation, or no row) is not complete', () => {
    expect(dayReportIsComplete(narrative('pending'))).toBe(false);
  });

  it('an unavailable report is not complete', () => {
    expect(dayReportIsComplete(narrative('unavailable'))).toBe(false);
  });

  it('a not_configured report is not complete', () => {
    expect(dayReportIsComplete(narrative('not_configured'))).toBe(false);
  });

  it('a failed write (null) is not complete', () => {
    expect(dayReportIsComplete(null)).toBe(false);
  });
});

describe('dayReportPushMayGo', () => {
  it('goes for a complete report (ready, refused)', () => {
    expect(dayReportPushMayGo(narrative('ready'))).toBe(true);
    expect(dayReportPushMayGo(narrative('refused'))).toBe(true);
  });

  it('goes for not_configured: no writer key, so no report is ever coming', () => {
    expect(dayReportPushMayGo(narrative('not_configured'))).toBe(true);
  });

  it('holds for pending, unavailable and a failed write (null)', () => {
    expect(dayReportPushMayGo(narrative('pending'))).toBe(false);
    expect(dayReportPushMayGo(narrative('unavailable'))).toBe(false);
    expect(dayReportPushMayGo(null)).toBe(false);
  });
});
