import { describe, expect, it } from 'vitest';

import { analyticsResponseSchema } from './analytics';

/**
 * THE anti-drift test for analytics — the dividends-contract arrangement,
 * for the same reason: the Swift structs are generated from the SCHEMA,
 * while the payload is `getAnalyticsView`'s return value. A field added to
 * the view but not the schema would ship a figure the phone silently cannot
 * see; one dropped would leave it decoding something that no longer arrives.
 *
 * The fixture is the empty-scope shape `emptyView` produces, plus one
 * populated slice / metric / point, so both the refusal path and a real
 * figure go through the schema.
 */

const SCOPE_ID = '22222222-2222-4222-8222-222222222222';

function metric(overrides: Record<string, unknown> = {}) {
  return {
    value: '+12,34%',
    direction: 'gain',
    note: null,
    ...overrides,
  };
}

function slice(overrides: Record<string, unknown> = {}) {
  return {
    key: 'AAPL',
    label: 'AAPL',
    value: '10 000,00 zł',
    pct: '+40,00%',
    share: '40',
    colorVar: 'var(--color-cat-1)',
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    scopeId: SCOPE_ID,
    scopes: [{ id: SCOPE_ID, name: 'Main' }],
    inceptionDateISO: '2024-01-15',
    xirr: metric(),
    twrrAnnualized: metric({ value: '+8,00%' }),
    twrrCumulative: metric({ value: '+20,00%' }),
    totalGain: '1 234,56 zł',
    totalGainDirection: 'gain',
    totalValue: '10 000,00 zł',
    breakdown: {
      ticker: [slice()],
      portfolio: [slice({ key: SCOPE_ID, label: 'Main' })],
      currency: [slice({ key: 'USD', label: 'USD' })],
      sector: [slice({ key: 'Technology', label: 'Technology' })],
    },
    concentration: { topSymbol: 'AAPL', topShare: '+40,00%', score: '34' },
    targetDrift: {
      rows: [
        {
          instrumentId: '33333333-3333-4333-8333-333333333333',
          symbol: 'AAPL',
          target: '+50,00%',
          actual: '+60,00%',
          drift: '+10,00 pp',
          amount: '1 000,00 zł',
          action: 'sell',
        },
        {
          // A held stock with NO target: nulls, never a zero target with a
          // sell order attached.
          instrumentId: '44444444-4444-4444-8444-444444444444',
          symbol: 'MSFT',
          target: null,
          actual: '+40,00%',
          drift: null,
          amount: null,
          action: null,
        },
      ],
      sumNote: 'Targets add up to 50,00%, not 100%.',
    },
    benchmark: {
      portfolio: [{ t: 1_704_067_200_000, v: '100' }, { t: 1_704_153_600_000, v: '110.5' }],
      benchmark: [{ t: 1_704_067_200_000, v: '100' }, { t: 1_704_153_600_000, v: '102' }],
      degradedReason: null,
    },
    excludedSymbols: [{ symbol: 'COLD', reason: 'no_price_history' }],
    skippedDays: 2,
    partialDays: 1,
    ...overrides,
  };
}

describe('analyticsResponseSchema', () => {
  it('accepts the shape getAnalyticsView actually produces', () => {
    const parsed = analyticsResponseSchema.parse(payload());

    expect(parsed.scopeId).toBe(SCOPE_ID);
    expect(parsed.xirr.value).toBe('+12,34%');
    expect(parsed.xirr.direction).toBe('gain');
    expect(parsed.breakdown.ticker[0].share).toBe('40');
    expect(parsed.concentration?.topSymbol).toBe('AAPL');
    expect(parsed.concentration?.score).toBe('34');
    expect(parsed.targetDrift?.rows[0].action).toBe('sell');
    expect(parsed.targetDrift?.rows[0].drift).toBe('+10,00 pp');
    expect(parsed.targetDrift?.rows[1].target).toBeNull();
    expect(parsed.targetDrift?.sumNote).toBe('Targets add up to 50,00%, not 100%.');
    expect(parsed.benchmark.portfolio[0].v).toBe('100');
    expect(parsed.excludedSymbols[0].reason).toBe('no_price_history');
  });

  it('accepts the empty-scope refusal shape', () => {
    const parsed = analyticsResponseSchema.parse(
      payload({
        scopeId: null,
        scopes: [],
        inceptionDateISO: null,
        xirr: metric({ value: '—', direction: 'neutral', note: 'No transactions in this scope yet.' }),
        twrrAnnualized: metric({ value: '—', direction: 'neutral', note: 'Nothing to measure yet.' }),
        twrrCumulative: metric({ value: '—', direction: 'neutral', note: 'Nothing to measure yet.' }),
        totalGain: null,
        totalGainDirection: 'neutral',
        totalValue: null,
        breakdown: { ticker: [], portfolio: [], currency: [], sector: [] },
        // The refusal path: an unpriceable scope carries null, never a zero
        // score, and the field is REQUIRED even so.
        concentration: null,
        // The All scope and the empty scope both carry null here, and the
        // field is REQUIRED even so — the `emptyView` trap.
        targetDrift: null,
        benchmark: { portfolio: [], benchmark: [], degradedReason: null },
        excludedSymbols: [],
        skippedDays: 0,
        partialDays: 0,
      }),
    );

    expect(parsed.scopeId).toBeNull();
    expect(parsed.xirr.note).toBe('No transactions in this scope yet.');
    expect(parsed.totalGain).toBeNull();
    expect(parsed.concentration).toBeNull();
    expect(parsed.targetDrift).toBeNull();
    expect(parsed.breakdown.ticker).toEqual([]);
  });

  it('carries every plotted value as a string, never a number', () => {
    expect(() =>
      analyticsResponseSchema.parse(
        payload({
          benchmark: {
            portfolio: [{ t: 1_704_067_200_000, v: 100 }],
            benchmark: [],
            degradedReason: 'no_benchmark_history',
          },
        }),
      ),
    ).toThrow();

    expect(() =>
      analyticsResponseSchema.parse(
        payload({
          breakdown: {
            ticker: [slice({ share: 40 })],
            portfolio: [],
            currency: [],
            sector: [],
          },
        }),
      ),
    ).toThrow();
  });

  it('names a degraded benchmark with a reason, never a fabricated line', () => {
    const parsed = analyticsResponseSchema.parse(
      payload({
        benchmark: {
          portfolio: [{ t: 1_704_067_200_000, v: '100' }],
          benchmark: [],
          degradedReason: 'no_benchmark_history',
        },
      }),
    );

    expect(parsed.benchmark.benchmark).toEqual([]);
    expect(parsed.benchmark.degradedReason).toBe('no_benchmark_history');
  });
});
