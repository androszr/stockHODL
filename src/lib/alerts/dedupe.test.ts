import { describe, expect, it } from 'vitest';

import { dec } from '@/lib/money';

import { nextAlertState } from './dedupe';

describe('nextAlertState — hysteresis state machine', () => {
  it('a missing row (never evaluated) defaults to armed and fires on a first cross', () => {
    expect(nextAlertState(null, dec(6))).toEqual({ armed: false, shouldFire: true });
  });

  it('a missing row below the fire threshold does not fire, and is recorded armed', () => {
    expect(nextAlertState(null, dec(4))).toEqual({ armed: true, shouldFire: false });
  });

  it('armed and crossing +5% fires and disarms', () => {
    expect(nextAlertState(true, dec(5))).toEqual({ armed: false, shouldFire: true });
  });

  it('armed and crossing -5% (a decline) fires too — direction is by the caller, magnitude by this function', () => {
    expect(nextAlertState(true, dec(-7.2))).toEqual({ armed: false, shouldFire: true });
  });

  it('unarmed and still beyond 5% does not fire again — the spam guard', () => {
    expect(nextAlertState(false, dec(8))).toEqual({ armed: false, shouldFire: false });
  });

  it('unarmed and retraced below 3% rearms, but does not itself fire', () => {
    expect(nextAlertState(false, dec(2))).toEqual({ armed: true, shouldFire: false });
  });

  it('unarmed and sitting in the 3–5% dead zone stays unarmed (no rearm yet)', () => {
    expect(nextAlertState(false, dec(4))).toEqual({ armed: false, shouldFire: false });
  });

  it('a second leg after retracing fires again', () => {
    const afterRetrace = nextAlertState(false, dec(2));
    expect(afterRetrace.armed).toBe(true);
    expect(nextAlertState(afterRetrace.armed, dec(6))).toEqual({ armed: false, shouldFire: true });
  });

  it('armed and sitting in the 3–5% dead zone stays armed and does not fire', () => {
    expect(nextAlertState(true, dec(4))).toEqual({ armed: true, shouldFire: false });
  });

  it('exactly 5% fires — the threshold is inclusive, not rounded away', () => {
    expect(nextAlertState(true, dec(5))).toEqual({ armed: false, shouldFire: true });
  });

  it('exactly 3% rearms — the reset threshold is exclusive of the dead zone above it', () => {
    expect(nextAlertState(false, dec(3))).toEqual({ armed: false, shouldFire: false });
    expect(nextAlertState(false, dec(2.999))).toEqual({ armed: true, shouldFire: false });
  });
});
