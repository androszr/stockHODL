import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dec } from '@/lib/money';

import {
  downsampleDayLine,
  fittedCap,
  lastRegularSession,
  regularSessionPoints,
  shouldShipWidgetDayLines,
  toSessionPercentSeries,
  WIDGET_DAY_LINE_MAX_POINTS,
} from './day-line';

describe('regularSessionPoints', () => {
  it('drops pre and post bars and keeps untagged regular ones', () => {
    const kept = regularSessionPoints([
      { t: 1, v: '100', p: 'pre' },
      { t: 2, v: '101' },
      { t: 3, v: '102', p: 'post' },
      { t: 4, v: '103' },
    ]);
    expect(kept.map((p) => p.t)).toEqual([2, 4]);
  });
});

describe('lastRegularSession', () => {
  it('picks the trailing regular date after dropping extended hours', () => {
    // 2026-09-17 15:00 ET and 2026-09-18 15:00 ET — two regular sessions.
    const wed = Date.parse('2026-09-17T19:00:00Z');
    const thu = Date.parse('2026-09-18T19:00:00Z');
    const thuPre = Date.parse('2026-09-18T10:00:00Z');
    const last = lastRegularSession([
      { t: wed, v: '100' },
      { t: thuPre, v: '101', p: 'pre' },
      { t: thu, v: '99' },
    ]);
    expect(last.map((p) => p.t)).toEqual([thu]);
  });
});

describe('toSessionPercentSeries', () => {
  it('maps a 100 baseline to 98.57 as about -1.43 percent', () => {
    const series = toSessionPercentSeries([{ t: 1, v: '98.57' }], '100');
    expect(series).toHaveLength(1);
    expect(dec(series[0].p).equals(dec('-1.43'))).toBe(true);
  });

  it('drops every point when the baseline is zero', () => {
    expect(toSessionPercentSeries([{ t: 1, v: '10' }], '0')).toEqual([]);
  });
});

describe('fittedCap', () => {
  it('is the larger abs, not a 3 percent lights cap', () => {
    const cap = fittedCap([{ t: 1, p: '-1.43' }], [{ t: 1, p: '-8.92' }]);
    expect(cap).not.toBeNull();
    expect(cap!.equals(dec('8.92'))).toBe(true);
    expect(cap!.equals(dec('3'))).toBe(false);
  });

  it('is null when both series are empty', () => {
    expect(fittedCap([], [])).toBeNull();
  });
});

describe('downsampleDayLine', () => {
  it('keeps first and last and never exceeds the cap', () => {
    const points = Array.from({ length: 200 }, (_, i) => ({
      t: i,
      p: `${i}.00`,
    }));
    const sampled = downsampleDayLine(points);
    expect(sampled[0]).toEqual(points[0]);
    expect(sampled[sampled.length - 1]).toEqual(points[points.length - 1]);
    expect(sampled.length).toBe(WIDGET_DAY_LINE_MAX_POINTS);
  });
});

describe('shouldShipWidgetDayLines', () => {
  // Regular sessions in EDT: 09:30–16:00 ET. Thursday then Friday.
  const thursday = {
    openMs: Date.parse('2026-09-17T13:30:00Z'),
    closeMs: Date.parse('2026-09-17T20:00:00Z'),
  };
  const friday = {
    openMs: Date.parse('2026-09-18T13:30:00Z'),
    closeMs: Date.parse('2026-09-18T20:00:00Z'),
  };
  const fridayBreakfast = Date.parse('2026-09-18T07:08:00Z'); // 03:08 ET / 09:08 Warsaw
  const fridayPre = Date.parse('2026-09-18T12:00:00Z'); // 08:00 ET early_trading
  const fridayCashOpen = Date.parse('2026-09-18T14:00:00Z'); // 10:00 ET; 1D may still be Thursday

  it('omits during early_trading even when yesterday is the last regular session', () => {
    expect(shouldShipWidgetDayLines('early_trading', thursday, fridayPre)).toBe(false);
  });

  it('omits an open status whose session is already yesterday', () => {
    expect(shouldShipWidgetDayLines('open', thursday, fridayCashOpen)).toBe(false);
  });

  it('ships a live today session', () => {
    expect(shouldShipWidgetDayLines('open', friday, fridayCashOpen)).toBe(true);
  });

  it('ships a closed yesterday session (breakfast in Warsaw)', () => {
    expect(shouldShipWidgetDayLines('closed', thursday, fridayBreakfast)).toBe(true);
  });

  it('does not live-colour a session whose close is already in the past', () => {
    expect(shouldShipWidgetDayLines('open', thursday, Date.parse('2026-09-18T20:30:00Z'))).toBe(
      false,
    );
    expect(shouldShipWidgetDayLines('open', friday, Date.parse('2026-09-18T20:30:00Z'))).toBe(
      false,
    );
  });
});

describe('money discipline', () => {
  it('does not call Number() or parseFloat', () => {
    const source = readFileSync(fileURLToPath(new URL('./day-line.ts', import.meta.url)), 'utf8');
    const banned = new RegExp(['parse' + 'Float', 'Numb' + 'er\\('].join('|'));
    expect(source).not.toMatch(banned);
  });
});
