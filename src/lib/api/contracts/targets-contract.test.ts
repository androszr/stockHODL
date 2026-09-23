import { describe, expect, it } from 'vitest';

import { targetsPutRequestSchema, targetsResponseSchema } from './targets';

/**
 * The targets door, both directions. The PUT body is `validation.ts`'s
 * schema re-exported, so these cases also pin that the import survived — a
 * restated bound would drift from the one the phone's own field enforces.
 */

const INSTRUMENT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

describe('targetsResponseSchema', () => {
  it('round-trips a saved list, targets as decimal strings', () => {
    const parsed = targetsResponseSchema.parse({
      rows: [
        { instrumentId: INSTRUMENT, symbol: 'AAPL', targetPct: '30' },
        { instrumentId: OTHER, symbol: 'MSFT', targetPct: '12.5' },
      ],
    });

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1].targetPct).toBe('12.5');
    expect(parsed.rows[1].symbol).toBe('MSFT');
  });

  it('requires a symbol on every row — the edit sheet names the instrument rather than inventing one', () => {
    expect(
      targetsResponseSchema.safeParse({ rows: [{ instrumentId: INSTRUMENT, targetPct: '30' }] })
        .success,
    ).toBe(false);
  });

  it('accepts a portfolio with no targets at all', () => {
    expect(targetsResponseSchema.parse({ rows: [] }).rows).toEqual([]);
  });

  it('refuses a non-uuid instrument id', () => {
    expect(
      targetsResponseSchema.safeParse({
        rows: [{ instrumentId: 'aapl', symbol: 'AAPL', targetPct: '30' }],
      }).success,
    ).toBe(false);
  });
});

describe('targetsPutRequestSchema', () => {
  it('accepts a bulk replace and normalises the pl-PL comma', () => {
    const parsed = targetsPutRequestSchema.parse({
      rows: [{ instrumentId: INSTRUMENT, targetPct: '12,5' }],
    });

    expect(parsed.rows[0].targetPct).toBe('12.5');
  });

  it('accepts an EMPTY save — clearing every target is a legal write', () => {
    // Blank ≠ zero: a cleared field is omitted from the body, so a save that
    // clears everything is an empty `rows`, not a list of zeros.
    expect(targetsPutRequestSchema.parse({ rows: [] }).rows).toEqual([]);
  });

  it('refuses a zero target — "no target" is an absent row', () => {
    expect(
      targetsPutRequestSchema.safeParse({ rows: [{ instrumentId: INSTRUMENT, targetPct: '0' }] })
        .success,
    ).toBe(false);
  });

  it('refuses the same instrument twice', () => {
    expect(
      targetsPutRequestSchema.safeParse({
        rows: [
          { instrumentId: INSTRUMENT, targetPct: '30' },
          { instrumentId: INSTRUMENT, targetPct: '40' },
        ],
      }).success,
    ).toBe(false);
  });
});
