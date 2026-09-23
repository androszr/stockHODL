import { describe, expect, it } from 'vitest';

import {
  TREND_DAYS,
  TREND_SESSIONS_NEEDED,
  isEmptyStrip,
  toTrendDays,
  type ClosePoint,
  type TrendSlot,
} from './day-trend';
import { EQUITY_TREND_SCALE, OPTION_TREND_SCALE } from './trend-scale';

/**
 * The grading table, the ordering contract, and the hole rules — the things
 * the strip's whole meaning rests on.
 *
 * Pure module, no fixture harness: this is the reason the grader was split
 * from the reader in the first place.
 */

const {
  flatMaxPct: FLAT_MAX_PCT,
  level1MaxPct: LEVEL_1_MAX_PCT,
  level2MaxPct: LEVEL_2_MAX_PCT,
} = EQUITY_TREND_SCALE;

/** Six sessions, oldest first — a full strip's worth, weekend gap included. */
const SESSIONS = [
  '2026-08-14',
  '2026-08-17',
  '2026-08-18',
  '2026-08-19',
  '2026-08-20',
  '2026-08-21',
] as const;

/** Valuations for whichever sessions the case names. */
function closes(...values: readonly (readonly [string, string])[]): ClosePoint[] {
  return values.map(([asOf, close]) => ({ asOf, close }));
}

/** A single graded session whose change is exactly `pct`. */
function movedBy(pct: number, scale = EQUITY_TREND_SCALE): TrendSlot[] {
  return toTrendDays(
    ['2026-08-20', '2026-08-21'],
    closes(['2026-08-20', '100'], ['2026-08-21', String(100 + pct)]),
    scale,
  );
}

/** Only the sessions that earned a mark — holes dropped. */
function graded(slots: readonly TrendSlot[]) {
  return slots.filter((slot): slot is NonNullable<TrendSlot> => slot !== null);
}

describe('toTrendDays — the thresholds, from both sides', () => {
  it('calls a move under a quarter of a percent flat, whatever its sign', () => {
    expect(movedBy(0.24)[0]).toMatchObject({ direction: 'neutral', level: 0 });
    expect(movedBy(-0.24)[0]).toMatchObject({ direction: 'neutral', level: 0 });
  });

  it('grades the flat boundary itself as level 1, not as flat', () => {
    // `< flatMaxPct` is strict, so 0.25 is the first graded move.
    expect(movedBy(FLAT_MAX_PCT)[0]).toMatchObject({ direction: 'gain', level: 1 });
  });

  it('steps up at each boundary and never past level 3', () => {
    expect(movedBy(0.99)[0]).toMatchObject({ level: 1 });
    expect(movedBy(LEVEL_1_MAX_PCT)[0]).toMatchObject({ level: 2 });
    expect(movedBy(2.99)[0]).toMatchObject({ level: 2 });
    expect(movedBy(LEVEL_2_MAX_PCT)[0]).toMatchObject({ level: 3 });
    expect(movedBy(40)[0]).toMatchObject({ level: 3 });
  });

  it('grades a loss by magnitude, symmetrically with a gain', () => {
    const loss = movedBy(-2)[0];
    expect(loss).toMatchObject({ direction: 'loss', level: 2 });
    expect(movedBy(2)[0]?.level).toBe(loss?.level);
  });

  it('reports the true percentage even on a day it grades as flat', () => {
    // `pct` is the honest figure for the accessibility phrase; `level` and
    // `direction` are the grading. A flat day is not a zero day.
    const [day] = movedBy(0.1);
    expect(day?.direction).toBe('neutral');
    expect(day?.pct).toContain('0,10');
  });

  it('carries no number except the level', () => {
    const [day] = movedBy(1.5);
    expect(typeof day?.pct).toBe('string');
    expect(typeof day?.date).toBe('string');
    expect(Number.isInteger(day?.level)).toBe(true);
  });
});

describe('toTrendDays — the scale is per asset class', () => {
  it('grades an option-sized move far below full height on the option scale', () => {
    // The whole reason the scale is a parameter: 3% is a big equity day and a
    // dull option one. One scale across both pegs every option bar at level 3,
    // which is a wall of identical bars carrying no information.
    expect(movedBy(3)[0]).toMatchObject({ level: 3 });
    expect(movedBy(3, OPTION_TREND_SCALE)[0]).toMatchObject({ level: 1 });
  });

  it('still reaches full height on an option-sized violent day', () => {
    expect(movedBy(35, OPTION_TREND_SCALE)[0]).toMatchObject({ direction: 'gain', level: 3 });
  });

  it('calls a 1% option session flat, where an equity session would be graded', () => {
    expect(movedBy(1, OPTION_TREND_SCALE)[0]).toMatchObject({ direction: 'neutral', level: 0 });
    expect(movedBy(1)[0]).toMatchObject({ level: 2 });
  });
});

describe('toTrendDays — shape and ordering', () => {
  it('turns six sessions into five days, oldest first', () => {
    const days = toTrendDays(
      SESSIONS,
      closes(
        ['2026-08-14', '101'],
        ['2026-08-17', '102'],
        ['2026-08-18', '103'],
        ['2026-08-19', '104'],
        ['2026-08-20', '105'],
        ['2026-08-21', '106'],
      ),
    );
    expect(days).toHaveLength(TREND_DAYS);
    expect(days.map((d) => d?.date)).toEqual([
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
    ]);
  });

  it('is exactly as long as the calendar it is given, not as long as its data', () => {
    // The strip's length is the CALENDAR's business. Over-fetching cannot
    // stretch it and a sparse contract cannot shrink it — that is what keeps
    // a hole in the middle addressable by column index.
    const many = Array.from({ length: 30 }, (_, i) => ({
      asOf: `2026-07-${String(i + 1).padStart(2, '0')}`,
      close: String(100 + i),
    }));
    expect(toTrendDays(SESSIONS, many)).toHaveLength(TREND_DAYS);
    expect(TREND_SESSIONS_NEEDED).toBe(TREND_DAYS + 1);
  });

  it('yields holes rather than a fabricated strip when data runs out', () => {
    const slots = toTrendDays(
      SESSIONS,
      closes(['2026-08-19', '99'], ['2026-08-20', '100'], ['2026-08-21', '101']),
    );
    expect(slots).toHaveLength(TREND_DAYS);
    expect(graded(slots).map((d) => d.date)).toEqual(['2026-08-20', '2026-08-21']);
    expect(slots.slice(0, 3)).toEqual([null, null, null]);
  });

  it('says nothing at all rather than something empty', () => {
    expect(isEmptyStrip(toTrendDays(SESSIONS, []))).toBe(true);
    expect(toTrendDays(SESSIONS, [])).toHaveLength(TREND_DAYS);
    expect(toTrendDays([], closes(['2026-08-21', '101']))).toEqual([]);
  });

  it('skips a pair whose previous close is zero instead of inventing a day', () => {
    // A zero close is a data fault; a direction derived from it would put a
    // coloured bar on a tile to describe a bug.
    const slots = toTrendDays(
      ['2026-08-19', '2026-08-20', '2026-08-21'],
      closes(['2026-08-19', '100'], ['2026-08-20', '0'], ['2026-08-21', '101']),
    );
    expect(graded(slots).map((d) => d.date)).toEqual(['2026-08-20']);
  });
});

describe('toTrendDays — a hole is not a flat day', () => {
  it('holes the missing session AND the one that would measure across it', () => {
    // This is the correction the whole rewrite exists for. Walking adjacent
    // stored rows would have compared 08-18 against 08-20 and drawn a 27%
    // jump as one session's move.
    const slots = toTrendDays(
      SESSIONS,
      closes(
        ['2026-08-14', '100'],
        ['2026-08-17', '101'],
        ['2026-08-18', '102'],
        // 08-19 never recorded.
        ['2026-08-20', '130'],
        ['2026-08-21', '131'],
      ),
    );
    expect(slots.map((s) => s?.date ?? null)).toEqual([
      '2026-08-17',
      '2026-08-18',
      null, // 08-19: no figure of its own
      null, // 08-20: its basis is missing
      '2026-08-21',
    ]);
  });

  it('grades a genuinely flat session rather than holing it', () => {
    const slots = toTrendDays(
      ['2026-08-20', '2026-08-21'],
      closes(['2026-08-20', '100'], ['2026-08-21', '100']),
    );
    expect(slots[0]).toMatchObject({ direction: 'neutral', level: 0 });
    expect(slots[0]).not.toBeNull();
  });
});

describe('toTrendDays — a change of instrument is not a return', () => {
  const point = (asOf: string, close: string, source: ClosePoint['source']): ClosePoint => ({
    asOf,
    close,
    source,
  });

  it('refuses to grade a mark against a traded close', () => {
    const slots = toTrendDays(
      ['2026-08-20', '2026-08-21'],
      [point('2026-08-20', '10', 'close'), point('2026-08-21', '13', 'mark')],
      OPTION_TREND_SCALE,
    );
    expect(slots).toEqual([null]);
  });

  it('grades a pair that agrees on its kind, in either kind', () => {
    const marks = toTrendDays(
      ['2026-08-20', '2026-08-21'],
      [point('2026-08-20', '10', 'mark'), point('2026-08-21', '13', 'mark')],
      OPTION_TREND_SCALE,
    );
    const prints = toTrendDays(
      ['2026-08-20', '2026-08-21'],
      [point('2026-08-20', '10', 'close'), point('2026-08-21', '13', 'close')],
      OPTION_TREND_SCALE,
    );
    expect(marks[0]).toMatchObject({ direction: 'gain', level: 3 });
    expect(prints[0]).toMatchObject({ direction: 'gain', level: 3 });
  });

  it('treats an untagged point as a traded close, so equity callers are unaffected', () => {
    const slots = toTrendDays(
      ['2026-08-20', '2026-08-21'],
      [{ asOf: '2026-08-20', close: '100' }, point('2026-08-21', '102', 'close')],
    );
    expect(slots[0]).toMatchObject({ direction: 'gain', level: 2 });
  });
});
