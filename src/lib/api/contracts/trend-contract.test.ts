import { describe, expect, it } from 'vitest';

import { staticHoldingSchema } from './bootstrap';
import { optionCardItemSchema } from './options';
import { trendDaySchema, trendDaysField } from './trend';
import { watchedItemSchema } from './watchlist';

/**
 * The wire shape's three load-bearing properties.
 *
 * The first is the GRADE'S BOUNDS: `level` is what the strip's geometry is
 * driven by, and a value outside 0–3 has no height to map to.
 *
 * The second is the UPGRADE PATH, and it is the one worth a test rather than
 * a comment. `trend` is optional so that the previous build's on-disk
 * snapshot — written before the field existed — still decodes on the first
 * launch after an upgrade. That is invisible in every other test, because
 * every other fixture is written by today's code. Here it is stated.
 *
 * The third is that a slot may be NULL. A hole and a flat day are different
 * facts — nothing was recorded, against the price went nowhere — and the wire
 * has to be able to say the first one, or the tile ends up asserting that a
 * contract sat still on a day it never traded.
 */

const holding = {
  instrumentId: '0f2a5471-0000-4000-8000-000000000001',
  symbol: 'AAPL',
  displayName: 'Apple Inc.',
  currency: 'USD',
  quantity: '10',
  avgCost: '150,00 USD',
  costBasisPLN: '10 000,00 zł',
  oversold: false,
};

const watched = {
  instrumentId: '0f2a5471-0000-4000-8000-000000000001',
  symbol: 'AAPL',
  displayName: 'Apple Inc.',
  currency: 'USD',
};

const day = { date: '2026-08-21', direction: 'gain', level: 2, pct: '+1,20%' };

describe('trendDaySchema', () => {
  it('accepts a graded session', () => {
    expect(trendDaySchema.safeParse(day).success).toBe(true);
  });

  it('refuses a level the strip has no height for', () => {
    expect(trendDaySchema.safeParse({ ...day, level: 4 }).success).toBe(false);
    expect(trendDaySchema.safeParse({ ...day, level: -1 }).success).toBe(false);
    expect(trendDaySchema.safeParse({ ...day, level: 1.5 }).success).toBe(false);
  });
});

describe('the carriers', () => {
  it('parse a payload with a full strip', () => {
    expect(staticHoldingSchema.safeParse({ ...holding, trend: [day] }).success).toBe(true);
    expect(watchedItemSchema.safeParse({ ...watched, trend: [day] }).success).toBe(true);
  });

  it('parse a payload with NO strip at all — the upgrade path', () => {
    expect(staticHoldingSchema.safeParse(holding).success).toBe(true);
    expect(watchedItemSchema.safeParse(watched).success).toBe(true);
  });

  it('refuse more sessions than the strip has slots', () => {
    const six = Array.from({ length: 6 }, () => day);
    expect(staticHoldingSchema.safeParse({ ...holding, trend: six }).success).toBe(false);
  });
});

describe('trendDaysField — a hole is a value the wire can carry', () => {
  it('accepts a null in any slot, including all of them', () => {
    expect(trendDaysField.safeParse([day, null, day, null, day]).success).toBe(true);
    expect(trendDaysField.safeParse([null, null, null, null, null]).success).toBe(true);
  });

  it('still refuses a malformed entry — nullable is not "anything"', () => {
    expect(trendDaysField.safeParse([{ ...day, level: 9 }]).success).toBe(false);
    expect(trendDaysField.safeParse([undefined]).success).toBe(false);
  });

  it('is absent-able rather than requiring an empty array', () => {
    expect(trendDaysField.safeParse(undefined).success).toBe(true);
  });
});

describe('the option card carries the same field', () => {
  // Asserted on the field rather than through a whole card fixture: what is
  // at stake is that options and equities spell the strip identically, and a
  // thirty-key fixture would restate the rest of the card to say it.
  const trend = optionCardItemSchema.shape.trend;

  it('takes a strip with holes in it', () => {
    expect(trend.safeParse([day, null, day]).success).toBe(true);
  });

  it('takes no strip at all — an option tile predates the field too', () => {
    expect(trend.safeParse(undefined).success).toBe(true);
  });

  it('refuses more sessions than the strip has slots', () => {
    expect(trend.safeParse(Array.from({ length: 6 }, () => day)).success).toBe(false);
  });
});
