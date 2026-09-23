import { describe, expect, it, vi } from 'vitest';

/**
 * The brand-icon proxy's injection gate, pinned where it now lives.
 *
 * It used to sit inline in `/api/logo/[symbol]/route.ts`. Since the native
 * client got its own bearer-guarded twin, both routes share this function —
 * which makes it exactly the kind of thing that must have a test: one gate,
 * two callers, and a param that ends up inside a vendor URL path.
 *
 * The vendor adapter is mocked away: this file's subject is the gate, and
 * importing `massive.ts` for real would drag in env validation and a fetch.
 */
vi.mock('server-only', () => ({}));
vi.mock('@/lib/market-data/massive', () => ({
  massiveProvider: { getBrandingIcon: vi.fn() },
}));

const { isLogoSymbol } = await import('@/lib/market-data/logo');

describe('isLogoSymbol', () => {
  it('accepts the ticker alphabet, including dotted classes', () => {
    expect(isLogoSymbol('AAPL')).toBe(true);
    expect(isLogoSymbol('BRK.A')).toBe(true);
    expect(isLogoSymbol('CDR.WA')).toBe(true);
    expect(isLogoSymbol('SPY-B')).toBe(true);
  });

  it('rejects traversal, even though a single dot is legitimate', () => {
    expect(isLogoSymbol('..')).toBe(false);
    expect(isLogoSymbol('A..B')).toBe(false);
  });

  it('rejects anything outside the alphabet', () => {
    expect(isLogoSymbol('aapl')).toBe(false);
    expect(isLogoSymbol('AA PL')).toBe(false);
    expect(isLogoSymbol('AAPL/../x')).toBe(false);
    expect(isLogoSymbol('AAPL?x=1')).toBe(false);
  });

  it('rejects the empty string and anything over twelve characters', () => {
    expect(isLogoSymbol('')).toBe(false);
    expect(isLogoSymbol('A'.repeat(12))).toBe(true);
    expect(isLogoSymbol('A'.repeat(13))).toBe(false);
  });
});
