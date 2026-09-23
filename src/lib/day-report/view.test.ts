import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { dayReportResponseSchema } from '@/lib/api/contracts/day-report';
import { canGenerateNarrative } from './view';

function payload() {
  return {
    status: 'ready', nearestDay: '2026-09-04', day: '2026-09-04', dayLabel: 'Friday, 4 September 2026', kind: 'close',
    prevDay: '2026-09-03', nextDay: null, isLatest: true,
    segments: { morning: 'ready', close: 'ready' }, scopeId: null,
    scopes: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Main' }],
    figures: { status: 'ready', source: 'stored', valueAtClose: '1 000,00 zł', dayChange: { text: '+10,00 zł', direction: 'gain' }, dayChangePct: '+1,00%', holdings: { valueAtClose: '900,00 zł', dayChange: { text: '+8,00 zł', direction: 'gain' }, dayChangePct: '+0,90%' }, options: { valueAtClose: '100,00 zł', dayChange: { text: '+2,00 zł', direction: 'gain' }, dayChangePct: '+2,00%' }, optionsDayChangeUSD: '+0,50 USD', optionsNote: null, optionsRelation: 'amplified', partial: false, partialSymbols: [], excludedSymbols: [], positionCount: 2 },
    recap: null,
    movers: [{ symbol: 'AAPL', displayName: 'Apple', contribution: { text: '+8,00 zł', direction: 'gain' }, pricePct: '+1,00%', barShare: '100' }],
    optionMovers: [], valueLine: { kind: 'daily', points: [{ t: 1_700_000_000_000, v: '1000' }], windowLabel: 'Sessions to 2026-09-04', partialDays: 0, excludedSymbols: [] },
    benchmarks: [{ indexName: 'S&P 500', proxySymbol: 'SPY', dayPct: '+1,00%', direction: 'gain', extendedPct: null, extendedKind: null }],
    usdPln: { rate: '4,0000', move: '+0,10%', direction: 'gain' }, headlines: [],
    events: { items: [], earningsCaption: "Earnings dates come from the day's macro search." },
    narrative: { status: 'pending', portfolioNarrative: null, eventsNarrative: null, macroNarrative: null, events: [], todayLine: null, sources: [], staleFigures: false },
  };
}

describe('day report view contract', () => {
  it('accepts the ready payload', () => expect(dayReportResponseSchema.parse(payload()).status).toBe('ready'));
  it('carries the split', () => expect(dayReportResponseSchema.parse(payload()).figures.options?.dayChange?.text).toContain('2,00'));
  it('carries an option relation', () => expect(dayReportResponseSchema.parse(payload()).figures.optionsRelation).toBe('amplified'));
  it('carries mover geometry as a string', () => expect(dayReportResponseSchema.parse(payload()).movers[0].barShare).toBe('100'));
  it('accepts market_open', () => expect(dayReportResponseSchema.parse({ ...payload(), segments: { morning: 'ready', close: 'market_open' } }).segments.close).toBe('market_open'));
  it('blocks a close narrative until final figures exist after the bell', () => {
    const open = dayReportResponseSchema.parse({ ...payload(), segments: { morning: 'ready', close: 'market_open' } });
    const notReady = dayReportResponseSchema.parse({ ...payload(), figures: { ...payload().figures, status: 'not_ready' } });
    const closed = dayReportResponseSchema.parse(payload());
    expect(canGenerateNarrative(open, 'close')).toBe(false);
    expect(canGenerateNarrative(notReady, 'close')).toBe(false);
    expect(canGenerateNarrative(closed, 'close')).toBe(true);
  });
  it('accepts a morning recap', () => expect(dayReportResponseSchema.parse({ ...payload(), kind: 'morning', recap: { day: '2026-09-03', dayChange: { text: '-1,00 zł', direction: 'loss' }, dayChangePct: '-0,10%' } }).recap?.day).toBe('2026-09-03'));
  it('accepts unavailable narrative', () => expect(dayReportResponseSchema.parse({ ...payload(), narrative: { ...payload().narrative, status: 'unavailable' } }).narrative.status).toBe('unavailable'));
  it('rejects numeric money', () => expect(() => dayReportResponseSchema.parse({ ...payload(), figures: { ...payload().figures, valueAtClose: 1000 } })).toThrow());
});
