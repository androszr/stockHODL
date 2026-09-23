import { describe, expect, it } from 'vitest';

import { composeMorningBriefAlert } from './morning-brief';

describe('composeMorningBriefAlert', () => {
  it('composes recap, the writer\'s today line and URL', () => {
    const alert = composeMorningBriefAlert({ recap: { dayChange: { text: '+100,00 zł' }, dayChangePct: '+1,00%' }, todayLine: 'Fed minutes Wed 14:00 · NKE earnings Thu', dayISO: '2026-09-21' });
    expect(alert?.body).toBe('Yesterday: +100,00 zł (+1,00%)\nFed minutes Wed 14:00 · NKE earnings Thu');
    expect(alert?.urlScheme).toBe('stockhodl://day-report/2026-09-21?kind=morning');
  });
  it('returns null with nothing honest to say', () => expect(composeMorningBriefAlert({ recap: null, todayLine: null, dayISO: '2026-09-21' })).toBeNull());
  it('treats a blank today line as none', () => expect(composeMorningBriefAlert({ recap: null, todayLine: '  ', dayISO: '2026-09-21' })).toBeNull());
  it('sends the today line alone when there is no recap', () => expect(composeMorningBriefAlert({ recap: null, todayLine: 'CPI Thu 08:30', dayISO: '2026-09-21' })?.body).toBe('CPI Thu 08:30'));
  it('keeps a recap without a percent', () => expect(composeMorningBriefAlert({ recap: { dayChange: { text: '0,00 zł' }, dayChangePct: null }, todayLine: null, dayISO: '2026-09-21' })?.body).toBe('Yesterday: 0,00 zł'));
});
