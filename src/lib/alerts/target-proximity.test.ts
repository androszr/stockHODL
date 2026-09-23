import { describe, expect, it } from 'vitest';

import { dec, fmtMoney, fmtPctUnsigned } from '@/lib/money';

import {
  NEAR_TARGET_THRESHOLD_PCT,
  proximityRank,
  targetGroupFor,
  targetStatusFor,
  type TargetLine,
} from './target-proximity';

/**
 * The proximity semantics, pinned once — every surface (watchlist tiles,
 * instrument sentence, mutation responses) reads through these functions, so
 * these tests ARE the feature's arithmetic contract.
 */

function line(overrides: Partial<TargetLine> = {}): TargetLine {
  return { targetPrice: '190', hitAtMs: null, createdAtMs: 1_757_000_000_000, ...overrides };
}

describe('targetStatusFor — the distance base and its formatting', () => {
  it('measures relative to the CURRENT price: 184 vs a 190 line is 3,26%, not 3,16%', () => {
    const status = targetStatusFor([line()], '184', 'USD');
    // (190-184)/184 = 3.2608…% — the base is the price, never the target.
    expect(status?.text).toBe(fmtPctUnsigned(dec('190').minus('184').div('184').times(100)));
    expect(status?.text).toBe('3,26%');
    expect(status?.side).toBe('below');
  });

  it('builds the sentence from the compact text, the side and fmtMoney (pl-PL, unsigned)', () => {
    const status = targetStatusFor([line()], '184', 'USD');
    expect(status?.sentence).toBe(`3,26% below your ${fmtMoney(dec('190'), 'USD')} line`);
    // pl-PL: comma decimal separator, currency code trailing, no '+' sign.
    expect(status?.sentence).toContain('190,00');
    expect(status?.sentence).not.toContain('+');
  });

  it('a price ABOVE the line reads "above" with the same unsigned distance', () => {
    const status = targetStatusFor([line({ targetPrice: '180' })], '184', 'USD');
    expect(status?.side).toBe('above');
    expect(status?.text).not.toContain('-');
    expect(status?.sentence).toContain('above your');
  });

  it('the 5% boundary is INCLUSIVE: exactly 5,00% is near, just outside is not', () => {
    // 100 → 105 is exactly 5%.
    const at = targetStatusFor([line({ targetPrice: '105' })], '100', 'USD');
    expect(at?.near).toBe(true);
    // 100 → 105.01 is 5.01%.
    const out = targetStatusFor([line({ targetPrice: '105.01' })], '100', 'USD');
    expect(out?.near).toBe(false);
    expect(NEAR_TARGET_THRESHOLD_PCT.eq(dec('5'))).toBe(true);
  });

  it('picks the NEAREST pending line across mixed above/below lines', () => {
    const status = targetStatusFor(
      [line({ targetPrice: '210' }), line({ targetPrice: '180' })],
      '184',
      'USD',
    );
    // 180 is 2.17% away, 210 is 14.13% away — nearest wins regardless of side.
    expect(status?.sentence).toContain(fmtMoney(dec('180'), 'USD'));
    expect(status?.side).toBe('above');
  });

  it('a distance tie goes to the OLDEST line', () => {
    const older = line({ targetPrice: '180', createdAtMs: 1 });
    const newer = line({ targetPrice: '188', createdAtMs: 2 });
    // Both are |4/184| away from 184.
    const status = targetStatusFor([newer, older], '184', 'USD');
    expect(status?.sentence).toContain(fmtMoney(dec('180'), 'USD'));
  });

  it('hit lines are excluded from the nearest search', () => {
    const hit = line({ targetPrice: '184.5', hitAtMs: 1_757_000_100_000 });
    const pending = line({ targetPrice: '200' });
    const status = targetStatusFor([hit, pending], '184', 'USD');
    expect(status?.sentence).toContain(fmtMoney(dec('200'), 'USD'));
    expect(status?.hitOnly).toBe(false);
  });

  it('only hit lines ⇒ hitOnly, group none, and the tile text "Hit"', () => {
    const status = targetStatusFor(
      [line({ targetPrice: '150', hitAtMs: 1_757_000_100_000 })],
      '184',
      'USD',
    );
    expect(status?.hitOnly).toBe(true);
    expect(status?.text).toBe('Hit');
    expect(status?.side).toBeNull();
    expect(status?.near).toBe(false);
    expect(targetGroupFor(status)).toBe('none');
  });

  it('no lines at all ⇒ null, group none', () => {
    expect(targetStatusFor([], '184', 'USD')).toBeNull();
    expect(targetGroupFor(null)).toBe('none');
  });

  it('no price, and a ZERO price, both ⇒ set with side null and text "—", never 0,00%', () => {
    for (const price of [null, '0']) {
      const status = targetStatusFor([line()], price, 'USD');
      expect(status?.text).toBe('—');
      expect(status?.side).toBeNull();
      expect(status?.near).toBe(false);
      expect(status?.hitOnly).toBe(false);
      expect(targetGroupFor(status)).toBe('set');
    }
  });

  it('distance zero ⇒ "at your … line", side null, text 0,00%', () => {
    const status = targetStatusFor([line({ targetPrice: '184' })], '184', 'USD');
    expect(status?.text).toBe('0,00%');
    expect(status?.side).toBeNull();
    expect(status?.near).toBe(true);
    expect(status?.sentence).toBe(`At your ${fmtMoney(dec('184'), 'USD')} line`);
  });

  it('a pending line the price GAPPED PAST reads its side from the live compare', () => {
    // Set while the price was below 190 (persisted direction "up"), but the
    // price is now 195 — the arrow must point DOWN toward the line, so the
    // side is where the price sits now: above it.
    const status = targetStatusFor([line({ targetPrice: '190' })], '195', 'USD');
    expect(status?.side).toBe('above');
  });

  it('groups: near within threshold, set outside it', () => {
    expect(targetGroupFor(targetStatusFor([line({ targetPrice: '186' })], '184', 'USD'))).toBe(
      'near',
    );
    expect(targetGroupFor(targetStatusFor([line({ targetPrice: '300' })], '184', 'USD'))).toBe(
      'set',
    );
  });
});

describe('proximityRank — the composer sort key', () => {
  it('is the unsigned Decimal distance of the nearest pending line', () => {
    const rank = proximityRank([line({ targetPrice: '180' }), line({ targetPrice: '210' })], '184');
    expect(rank?.eq(dec('4').div('184').times(100).abs())).toBe(true);
  });

  it('is null with no usable price, no pending line, or only hit lines', () => {
    expect(proximityRank([line()], null)).toBeNull();
    expect(proximityRank([line()], '0')).toBeNull();
    expect(proximityRank([], '184')).toBeNull();
    expect(proximityRank([line({ hitAtMs: 1 })], '184')).toBeNull();
  });
});
