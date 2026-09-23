import { describe, expect, it } from 'vitest';

import {
  priceTargetCreateRequestSchema,
  priceTargetSchema,
  priceTargetsResponseSchema,
  targetSideSchema,
  targetStatusSchema,
} from './price-targets';

const TARGET = {
  id: '11111111-1111-4111-8111-111111111111',
  instrumentId: '22222222-2222-4222-8222-222222222222',
  targetPrice: '190.5',
  direction: 'up',
  hitAtMs: null,
  createdAtMs: 1_757_000_000_000,
};

describe('priceTargetSchema', () => {
  it('round-trips a pending target — hitAtMs null means waiting, never epoch zero', () => {
    const parsed = priceTargetSchema.parse(TARGET);
    expect(parsed.hitAtMs).toBeNull();
    expect(parsed.targetPrice).toBe('190.5');
  });

  it('round-trips a hit target with its instant', () => {
    const parsed = priceTargetSchema.parse({
      ...TARGET,
      direction: 'down',
      hitAtMs: 1_757_000_600_000,
    });
    expect(parsed.hitAtMs).toBe(1_757_000_600_000);
    expect(parsed.direction).toBe('down');
  });

  it('refuses a direction outside the closed pair', () => {
    expect(priceTargetSchema.safeParse({ ...TARGET, direction: 'sideways' }).success).toBe(false);
  });

  it('refuses a non-uuid id', () => {
    expect(priceTargetSchema.safeParse({ ...TARGET, id: 'abc' }).success).toBe(false);
  });
});

describe('priceTargetCreateRequestSchema', () => {
  const body = { instrumentId: TARGET.instrumentId, targetPrice: '190.5' };

  it('accepts a positive decimal price', () => {
    expect(priceTargetCreateRequestSchema.parse(body).targetPrice).toBe('190.5');
  });

  it('normalises the pl-PL comma — the same rule every money input follows', () => {
    expect(priceTargetCreateRequestSchema.parse({ ...body, targetPrice: '190,5' }).targetPrice).toBe(
      '190.5',
    );
  });

  it('refuses zero and negative prices — there is no line to draw at them', () => {
    expect(priceTargetCreateRequestSchema.safeParse({ ...body, targetPrice: '0' }).success).toBe(
      false,
    );
    expect(priceTargetCreateRequestSchema.safeParse({ ...body, targetPrice: '-5' }).success).toBe(
      false,
    );
  });

  it('refuses a value that reads as thousands grouping', () => {
    expect(
      priceTargetCreateRequestSchema.safeParse({ ...body, targetPrice: '1,234' }).success,
    ).toBe(false);
  });

  it('refuses a non-uuid instrument id', () => {
    expect(
      priceTargetCreateRequestSchema.safeParse({ ...body, instrumentId: '../etc' }).success,
    ).toBe(false);
  });

  it('refuses a non-numeric price', () => {
    expect(
      priceTargetCreateRequestSchema.safeParse({ ...body, targetPrice: 'abc' }).success,
    ).toBe(false);
  });
});

const STATUS = {
  text: '3,26%',
  sentence: '3,26% below your 190,00 USD line',
  side: 'below',
  near: true,
  hitOnly: false,
};

describe('targetStatusSchema', () => {
  it('round-trips the proximity readout — both strings server-formatted', () => {
    const parsed = targetStatusSchema.parse(STATUS);
    expect(parsed.side).toBe('below');
    expect(parsed.near).toBe(true);
  });

  it('accepts the null-side shapes: at the line, unpriced, hit-only', () => {
    expect(targetStatusSchema.parse({ ...STATUS, side: null }).side).toBeNull();
    expect(
      targetStatusSchema.parse({
        text: 'Hit',
        sentence: 'Your 190,00 USD line has been hit',
        side: null,
        near: false,
        hitOnly: true,
      }).hitOnly,
    ).toBe(true);
  });

  it('refuses a side outside the closed pair — the display Direction enum is a different thing', () => {
    expect(targetSideSchema.safeParse('up').success).toBe(false);
    expect(targetStatusSchema.safeParse({ ...STATUS, side: 'gain' }).success).toBe(false);
  });

  it('refuses a numeric distance — a percent crosses the wire formatted, never as a number', () => {
    expect(targetStatusSchema.safeParse({ ...STATUS, text: 3.26 }).success).toBe(false);
  });
});

describe('priceTargetsResponseSchema', () => {
  it('round-trips the list both mutation routes answer, status included', () => {
    const parsed = priceTargetsResponseSchema.parse({ targets: [TARGET], status: STATUS });
    expect(parsed.targets).toHaveLength(1);
    expect(parsed.status?.near).toBe(true);
  });

  it('an empty list with a null status is a valid answer — the last target was just deleted', () => {
    const parsed = priceTargetsResponseSchema.parse({ targets: [], status: null });
    expect(parsed.targets).toEqual([]);
    expect(parsed.status).toBeNull();
  });

  it('the status field is required — an answer without it is a producer bug, not an old shape', () => {
    expect(priceTargetsResponseSchema.safeParse({ targets: [] }).success).toBe(false);
  });
});
