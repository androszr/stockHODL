import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { regularSessionFor } from '@/lib/market-data/market-clock';

import { dailySummaryDayToSend, morningBriefDayToSend } from './daily-summary';

/**
 * The push schedule in `vercel.json` against the real day functions, in both
 * halves of the year (plans/2026-09-23-report-push-waits-for-report.md).
 * Cron is UTC-only, so the DST reasoning behind each slot is only as good as
 * this test: every morning slot must land before the open (13:30 UTC in
 * summer), every evening slot either before the close (a no-op) or at least
 * fifteen minutes after it — never inside `[close, close + 15 min)`, where the
 * close report would be written from 15-minute-delayed quotes and then never
 * regenerated. That window is why `21:00 UTC` is not a slot.
 */

interface CronEntry {
  path: string;
  schedule: string;
}

const config = JSON.parse(
  readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'),
) as { crons: CronEntry[] };

const SLOT = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/;

function slotsFor(path: string): Array<{ schedule: string; minute: number; hour: number }> {
  return config.crons
    .filter((entry) => entry.path === path)
    .map((entry) => {
      const match = SLOT.exec(entry.schedule);
      if (match === null) throw new Error(`${path}: unexpected schedule shape "${entry.schedule}"`);
      return { schedule: entry.schedule, minute: Number(match[1]), hour: Number(match[2]) };
    });
}

function instantOn(dayISO: string, hour: number, minute: number): number {
  const [y, m, d] = dayISO.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hour, minute);
}

const DAYS = [
  { half: 'summer', day: '2026-07-15' },
  { half: 'winter', day: '2026-01-14' },
];

const DAILY = slotsFor('/api/cron/daily-summary');
const MORNING = slotsFor('/api/cron/morning-brief');

describe('push cron slots', () => {
  it('lists exactly the eight evening slots and the four morning slots', () => {
    expect(DAILY.map((s) => s.schedule)).toEqual(
      ['15 20', '30 20', '45 20', '15 21', '30 21', '45 21', '0 22', '15 22'].map(
        (s) => `${s} * * 1-5`,
      ),
    );
    expect(MORNING.map((s) => s.schedule)).toEqual(
      ['30 12', '45 12', '0 13', '15 13'].map((s) => `${s} * * 1-5`),
    );
  });

  for (const { half, day } of DAYS) {
    it(`every morning slot answers the day before the open (${half})`, () => {
      for (const slot of MORNING) {
        expect(morningBriefDayToSend(instantOn(day, slot.hour, slot.minute), [])).toBe(day);
      }
    });

    it(`every evening slot is a no-op or answers the day, never inside the delay window (${half})`, () => {
      const closeMs = regularSessionFor(day, [])!.closeMs;
      let answered = 0;
      for (const slot of DAILY) {
        const ms = instantOn(day, slot.hour, slot.minute);
        const sent = dailySummaryDayToSend(ms, []);
        expect([null, day]).toContain(sent);
        if (sent === day) answered++;
        const insideDelay = ms >= closeMs && ms < closeMs + 15 * 60_000;
        expect(insideDelay, `${slot.schedule} is inside [close, close + 15 min)`).toBe(false);
      }
      expect(answered).toBeGreaterThan(0);
    });
  }
});
