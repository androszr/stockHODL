import { describe, expect, it } from 'vitest';

import type { ChartPoint } from './series';
import { tagSessionPhases } from './session-phase';

/**
 * All instants are stated as UTC on 2026-08-12, a plain Wednesday in EDT
 * (UTC−4): the regular session is 13:30–20:00 UTC. Extended bars around it are
 * what the vendor actually returns for a US listing (04:00–20:00 ET).
 */
const at = (utc: string): number => Date.parse(`2026-08-12T${utc}:00Z`);
const point = (utc: string): ChartPoint => ({ t: at(utc), v: '10' });

describe('tagSessionPhases — the vendor does not label its bars, the clock does', () => {
  it('splits a day into pre / regular / post around the real session bounds', () => {
    const tagged = tagSessionPhases(
      [point('11:00'), point('13:25'), point('13:30'), point('19:55'), point('20:00'), point('23:00')],
      [],
    );

    expect(tagged.map((p) => p.p)).toEqual([
      'pre',
      'pre',
      undefined, // 09:30 ET — the opening bar is regular
      undefined, // 15:55 ET — runs UP TO the close, still regular
      'post', // 16:00 ET — the first bar the regular session did not produce
      'post',
    ]);
  });

  it('never mutates the value or the timestamp it rides along with', () => {
    const input = [point('11:00')];
    const [tagged] = tagSessionPhases(input, []);

    expect(tagged.v).toBe('10');
    expect(tagged.t).toBe(at('11:00'));
    expect(input[0].p).toBeUndefined();
  });

  it('honours an early close — 13:00 ET ends the session, after-hours starts there', () => {
    const tagged = tagSessionPhases([point('16:55'), point('17:00')], [
      { date: '2026-08-12', status: 'early-close' },
    ]);

    expect(tagged.map((p) => p.p)).toEqual([undefined, 'post']);
  });

  it('shades nothing on a date the calendar closes outright', () => {
    const tagged = tagSessionPhases([point('11:00'), point('23:00')], [
      { date: '2026-08-12', status: 'closed' },
    ]);

    expect(tagged.map((p) => p.p)).toEqual([undefined, undefined]);
  });
});
