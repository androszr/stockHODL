import { describe, expect, it } from 'vitest';

import { optionContractRefSchema, optionExpirySchema } from '@/lib/api/contracts';

import { mobileExpiryLabel, mobileStrikeLabel, toMobileContractRef, toMobileExpiry } from './option-chain-labels';

/**
 * Regression test for the bug that shipped with no test coverage: the three
 * mobile option-chain routes (`/options/expirations`, `/options/strikes`,
 * `/import/option/match`) answered `listOptionExpirations`/`listOptionStrikes`
 * results verbatim — `{ date }` and no `strikeLabel` — while the mobile
 * contract they claim to implement (`optionExpirySchema`, `optionContractRefSchema`
 * in `src/lib/api/contracts/options.ts`) requires `expirationDate` + `label`
 * and `strikeLabel`. The Swift client decodes against that contract and threw
 * a `keyNotFound` on every single chain lookup — every option add, screenshot
 * or manual, always landed on "Contract lookup is unavailable". Parsing the
 * mapped output through the SAME zod schema the Swift codegen reads is what
 * would have caught this before it shipped.
 */
describe('option chain labels', () => {
  it('formats an expiry as a pl-PL date', () => {
    expect(mobileExpiryLabel('2026-12-18')).toBe('18 gru 2026');
  });

  it('formats a strike with no trailing zeros', () => {
    expect(mobileStrikeLabel('660.00')).toBe('660');
    expect(mobileStrikeLabel('12.5')).toBe('12,5');
  });

  it('toMobileExpiry satisfies the mobile contract the Swift client decodes', () => {
    const mapped = toMobileExpiry({ date: '2026-12-18' });
    expect(mapped).toEqual({ expirationDate: '2026-12-18', label: '18 gru 2026' });
    expect(() => optionExpirySchema.parse(mapped)).not.toThrow();
  });

  it('toMobileContractRef satisfies the mobile contract the Swift client decodes', () => {
    const mapped = toMobileContractRef({
      ticker: 'O:META261218C00660000',
      underlying: 'META',
      contractType: 'call',
      strikePrice: '660.00',
      expirationDate: '2026-12-18',
      sharesPerContract: '100',
    });
    expect(mapped.strikeLabel).toBe('660');
    expect(() => optionContractRefSchema.parse(mapped)).not.toThrow();
  });
});
