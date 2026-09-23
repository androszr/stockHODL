import { describe, expect, it } from 'vitest';

import type { DayReportResponse } from '@/lib/api/contracts/day-report';

import { dayReportFacts } from './facts';

function view(): DayReportResponse {
  return {
    status: 'ready', nearestDay: '2026-09-04', day: '2026-09-04', dayLabel: 'Friday, 4 September 2026', kind: 'close',
    prevDay: null, nextDay: null, isLatest: true, segments: { morning: 'ready', close: 'ready' }, scopeId: null, scopes: [],
    figures: { status: 'ready', source: 'stored', valueAtClose: '10 000,00 zł', dayChange: { text: '+100,00 zł', direction: 'gain' }, dayChangePct: '+1,00%', holdings: { valueAtClose: '9 000,00 zł', dayChange: { text: '+80,00 zł', direction: 'gain' }, dayChangePct: '+0,90%' }, options: null, optionsDayChangeUSD: null, optionsNote: null, optionsRelation: null, partial: false, partialSymbols: [], excludedSymbols: [], positionCount: 1 },
    recap: null,
    movers: Array.from({ length: 7 }, (_, index) => ({ symbol: `S${index}`, displayName: `Stock ${index}`, contribution: { text: `+${index},00 zł`, direction: 'gain' as const }, pricePct: '+1,00%', barShare: '100' })),
    optionMovers: [], valueLine: { kind: 'none', points: [], windowLabel: null, partialDays: 0, excludedSymbols: [] }, benchmarks: [], usdPln: null,
    headlines: Array.from({ length: 14 }, (_, index) => ({ id: `${index}`, title: `Headline ${index}`, publisherName: null, publishedAtMs: 1_700_000_000_000 + index, matchedTickers: ['S0'], sentiment: null, url: `https://news.example/${index}`, summary: null })),
    events: { items: [], earningsCaption: 'Earnings via search.' },
    narrative: { status: 'pending', portfolioNarrative: null, eventsNarrative: null, macroNarrative: null, events: [], todayLine: null, sources: [], staleFigures: false },
  };
}

describe('dayReportFacts', () => {
  it('preserves preformatted money', () => expect(dayReportFacts(view()).headline.valueAtClose).toBe('10 000,00 zł'));
  it('caps movers at five', () => expect(dayReportFacts(view()).movers).toHaveLength(5));
  it('caps headlines at twelve', () => expect(dayReportFacts(view()).headlines).toHaveLength(12));
  it('hands the writer each headline url so web_fetch can open it', () =>
    expect(dayReportFacts(view()).headlines[0]).toMatchObject({ url: 'https://news.example/0', summary: null }));
  it('keeps a stable JSON key order', () => expect(Object.keys(dayReportFacts(view()))).toEqual(['kind', 'day', 'weekday', 'week', 'scope', 'heldSymbols', 'optionPositions', 'headline', 'recap', 'movers', 'benchmarks', 'usdPln', 'headlines', 'events']));
  it('never forwards the events caption — the writer paraphrased it into the report', () =>
    expect(JSON.stringify(dayReportFacts(view()))).not.toContain('Earnings via search'));
  it('tells the writer the weekday and the Monday..Friday window', () =>
    expect(dayReportFacts(view())).toMatchObject({ weekday: 'Friday', week: { from: '2026-08-31', to: '2026-09-04' } }));
  it('forwards every held name and option position, not just the movers', () => {
    const held = { symbols: [{ symbol: 'NKE', name: 'Nike' }], options: [{ underlying: 'NKE', label: 'NKE 60C Oct26', expirationDate: '2026-10-16' }] };
    expect(dayReportFacts(view(), 'All portfolios', held)).toMatchObject({ heldSymbols: held.symbols, optionPositions: held.options });
  });
});
