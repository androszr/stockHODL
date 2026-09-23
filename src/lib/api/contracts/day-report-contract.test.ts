import { describe, expect, it } from 'vitest';

import { dayReportResponseSchema } from './day-report';

function report(kind: 'morning' | 'close') {
  return {
    status: 'ready',
    nearestDay: '2026-09-18',
    day: '2026-09-18',
    dayLabel: 'Friday, 18 September 2026',
    kind,
    prevDay: '2026-09-17',
    nextDay: null,
    isLatest: true,
    segments: { morning: 'ready', close: 'ready' },
    scopeId: null,
    scopes: [],
    figures: {
      status: 'ready', source: 'stored', valueAtClose: '10 000,00 zł',
      dayChange: { text: '+100,00 zł', direction: 'gain' }, dayChangePct: '+1,00%',
      holdings: null, options: null, optionsDayChangeUSD: null, optionsNote: null,
      optionsRelation: null, partial: false, partialSymbols: [], excludedSymbols: [], positionCount: 1,
    },
    recap: kind === 'morning'
      ? { day: '2026-09-17', dayChange: { text: '+80,00 zł', direction: 'gain' }, dayChangePct: '+0,80%' }
      : null,
    movers: [], optionMovers: [],
    valueLine: { kind: kind === 'close' ? 'daily' : 'none', points: [], windowLabel: null, partialDays: 0, excludedSymbols: [] },
    benchmarks: [], usdPln: null, headlines: [],
    events: { items: [], earningsCaption: "Earnings dates appear in the written report." },
    narrative: { status: 'pending', portfolioNarrative: null, eventsNarrative: null, macroNarrative: null, events: [], todayLine: null, sources: [], staleFigures: false },
  };
}

describe('dayReportResponseSchema', () => {
  it('accepts the close view shape', () => {
    const parsed = dayReportResponseSchema.parse(report('close'));
    expect(parsed.kind).toBe('close');
    expect(parsed.figures.dayChange?.text).toBe('+100,00 zł');
  });

  it('accepts the morning view shape with its prior-session recap', () => {
    const parsed = dayReportResponseSchema.parse(report('morning'));
    expect(parsed.kind).toBe('morning');
    expect(parsed.recap?.day).toBe('2026-09-17');
  });
});
