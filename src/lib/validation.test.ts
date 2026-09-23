import { describe, expect, it } from 'vitest';

import { nyDateISOAt } from './market-data/market-clock';
import {
  decimalString,
  portfolioNameSchema,
  portfolioTargetsPutSchema,
  targetPctSchema,
  transactionInputSchema,
} from './validation';

const validPln = {
  portfolioId: '7f1e0a54-3c1e-4d5f-9b2a-1c2d3e4f5a6b',
  side: 'buy',
  symbol: 'CDR.WA',
  displayName: 'CD Projekt',
  exchange: 'GPW',
  currency: 'PLN',
  quantity: '10',
  price: '300',
  fees: '5',
  tradeDate: '2026-08-08',
};

describe('transactionInputSchema — fx rule', () => {
  it("forces fxRateToBase to exactly '1' for PLN, even when the client sends something else", () => {
    const parsed = transactionInputSchema.parse({ ...validPln, fxRateToBase: '4.05' });
    expect(parsed.fxRateToBase).toBe('1');
  });

  it("defaults fxRateToBase to '1' for PLN when the field is absent (disabled input)", () => {
    const parsed = transactionInputSchema.parse(validPln);
    expect(parsed.fxRateToBase).toBe('1');
  });

  it('rejects a non-PLN transaction with no fx rate', () => {
    const result = transactionInputSchema.safeParse({ ...validPln, currency: 'USD' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'fxRateToBase')).toBe(true);
    }
  });

  it('rejects a non-positive fx rate for a non-PLN currency', () => {
    const result = transactionInputSchema.safeParse({
      ...validPln,
      currency: 'USD',
      fxRateToBase: '0',
    });
    expect(result.success).toBe(false);
  });

  it('passes a valid non-PLN input through with its fx rate preserved', () => {
    const parsed = transactionInputSchema.parse({
      ...validPln,
      currency: 'USD',
      fxRateToBase: '4.05',
    });
    expect(parsed.fxRateToBase).toBe('4.05');
    expect(parsed.currency).toBe('USD');
  });
});

describe('transactionInputSchema — decimal discipline', () => {
  it("rejects quantity 'abc'", () => {
    const result = transactionInputSchema.safeParse({ ...validPln, quantity: 'abc' });
    expect(result.success).toBe(false);
  });

  it('rejects a negative price', () => {
    const result = transactionInputSchema.safeParse({ ...validPln, price: '-300' });
    expect(result.success).toBe(false);
  });

  it('rejects a zero quantity', () => {
    const result = transactionInputSchema.safeParse({ ...validPln, quantity: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects negative fees', () => {
    const result = transactionInputSchema.safeParse({ ...validPln, fees: '-1' });
    expect(result.success).toBe(false);
  });

  it("defaults empty fees to '0'", () => {
    const parsed = transactionInputSchema.parse({ ...validPln, fees: '' });
    expect(parsed.fees).toBe('0');
  });

  it('uppercases and trims the symbol', () => {
    const parsed = transactionInputSchema.parse({ ...validPln, symbol: ' cdr.wa ' });
    expect(parsed.symbol).toBe('CDR.WA');
  });

  it('rejects a trade date that is not YYYY-MM-DD', () => {
    const result = transactionInputSchema.safeParse({ ...validPln, tradeDate: '08/08/2026' });
    expect(result.success).toBe(false);
  });

  it('accepts comma-decimal quantity and price, storing the dot form', () => {
    const parsed = transactionInputSchema.parse({
      ...validPln,
      quantity: '10,5',
      price: '300,5',
    });
    expect(parsed.quantity).toBe('10.5');
    expect(parsed.price).toBe('300.5');
  });

  it('accepts a comma-decimal fx rate for a non-PLN currency', () => {
    const parsed = transactionInputSchema.parse({
      ...validPln,
      currency: 'USD',
      fxRateToBase: '4,05',
    });
    expect(parsed.fxRateToBase).toBe('4.05');
  });

  it('rejects an fx rate finer than the numeric(20,10) storage scale', () => {
    const result = transactionInputSchema.safeParse({
      ...validPln,
      currency: 'USD',
      fxRateToBase: '4.05000000001', // 11 dp
    });
    expect(result.success).toBe(false);
  });

  it('rejects a price that would overflow numeric(20,8)', () => {
    const result = transactionInputSchema.safeParse({ ...validPln, price: '999999999999999' });
    expect(result.success).toBe(false);
  });

  it('rejects a quantity that would round to zero at storage scale', () => {
    const result = transactionInputSchema.safeParse({ ...validPln, quantity: '0.000000001' });
    expect(result.success).toBe(false);
  });

  it("rejects a thousands-grouped quantity like '1,000' instead of storing 1", () => {
    const result = transactionInputSchema.safeParse({ ...validPln, quantity: '1,000' });
    expect(result.success).toBe(false);
  });

  it('rejects a currency outside the supported list', () => {
    // instruments is global and first-write-wins on symbol: a typo'd code
    // would bind the symbol permanently with no NBP rate source for it.
    expect(transactionInputSchema.safeParse({ ...validPln, currency: 'XXX' }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...validPln, currency: 'usd' }).success).toBe(false);
  });
});

describe('transactionInputSchema — calendar validity', () => {
  it('rejects impossible calendar dates that match the format regex', () => {
    expect(transactionInputSchema.safeParse({ ...validPln, tradeDate: '2026-02-31' }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...validPln, tradeDate: '2026-13-01' }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...validPln, tradeDate: '2026-04-31' }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...validPln, tradeDate: '2026-01-00' }).success).toBe(false);
  });

  it('understands leap years', () => {
    expect(transactionInputSchema.safeParse({ ...validPln, tradeDate: '2024-02-29' }).success).toBe(true);
    expect(transactionInputSchema.safeParse({ ...validPln, tradeDate: '2025-02-29' }).success).toBe(false);
    // Century rule: 2000 was a leap year, 1900 was not.
    expect(transactionInputSchema.safeParse({ ...validPln, tradeDate: '2000-02-29' }).success).toBe(true);
    expect(transactionInputSchema.safeParse({ ...validPln, tradeDate: '1900-02-29' }).success).toBe(false);
  });
});

describe('decimalString', () => {
  it('accepts a plain decimal and rejects float garbage', () => {
    expect(decimalString().safeParse('0.30000004').success).toBe(true);
    expect(decimalString().safeParse('NaN').success).toBe(false);
    expect(decimalString().safeParse('Infinity').success).toBe(false);
    expect(decimalString().safeParse('').success).toBe(false);
  });

  it('accepts a lone comma as the decimal separator (pl-PL numeric pad)', () => {
    const result = decimalString().safeParse('1,5');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('1.5');
  });

  it('normalizes the comma form to the same stored value as the dot form', () => {
    const comma = decimalString().safeParse('300,5');
    const dot = decimalString().safeParse('300.5');
    expect(comma.success && dot.success).toBe(true);
    if (comma.success && dot.success) expect(comma.data).toBe(dot.data);
  });

  it('rejects mixed or repeated separators rather than guessing', () => {
    expect(decimalString().safeParse('1.234,5').success).toBe(false);
    expect(decimalString().safeParse('1,234.5').success).toBe(false);
    expect(decimalString().safeParse('1,2,3').success).toBe(false);
  });

  it('refuses to guess when the comma looks like thousands grouping', () => {
    // '1,000' normalized to '1.000' would silently store 1 instead of 1000 —
    // a 1000x error. These must be rejected, never rewritten.
    const grouped = decimalString().safeParse('1,000');
    expect(grouped.success).toBe(false);
    if (!grouped.success) {
      expect(grouped.error.issues[0].message).toMatch(/thousands separator/);
    }
    expect(decimalString().safeParse('1,250').success).toBe(false);
    expect(decimalString().safeParse('12,345').success).toBe(false);
  });

  it("keeps the deliberate '0,125' carve-out and the short comma forms", () => {
    // A '0' integer part is never grouping — this stays valid so fractional
    // shares remain enterable on the comma-only pl-PL mobile pad.
    const fractional = decimalString().safeParse('0,125');
    expect(fractional.success).toBe(true);
    if (fractional.success) expect(fractional.data).toBe('0.125');

    const price = decimalString().safeParse('350,50');
    expect(price.success).toBe(true);
    if (price.success) expect(price.data).toBe('350.50');

    const half = decimalString().safeParse('0,5');
    expect(half.success).toBe(true);
    if (half.success) expect(half.data).toBe('0.5');
  });

  it('bounds magnitude to what numeric(20,8) can store', () => {
    expect(decimalString().safeParse('999999999999').success).toBe(true); // 12 digits
    expect(decimalString().safeParse('999999999999999').success).toBe(false); // 15 digits
    expect(decimalString().safeParse('1e15').success).toBe(false);
  });

  it('bounds scale and rejects values that round to zero at storage scale', () => {
    expect(decimalString().safeParse('0.00000001').success).toBe(true); // 8 dp
    expect(decimalString().safeParse('0.000000001').success).toBe(false); // 9 dp
    expect(decimalString({ positive: true }).safeParse('1e-9').success).toBe(false);
    expect(decimalString().safeParse('0.123456789').success).toBe(false); // 9 dp, no rounding rescue
  });
});

describe('portfolioNameSchema', () => {
  it('trims and bounds the name', () => {
    expect(portfolioNameSchema.parse('  IKE  ')).toBe('IKE');
    expect(portfolioNameSchema.safeParse('   ').success).toBe(false);
    expect(portfolioNameSchema.safeParse('x'.repeat(61)).success).toBe(false);
  });
});

/**
 * Bug audit 2026-08-19, minor 3: `tradeDate` had a format check and a
 * calendar check but no forward bound, so a year typo'd as `2035` was stored
 * and then stretched the analytics XIRR discount window by nine years.
 */
describe('transactionInputSchema — the trade date cannot be in the future', () => {
  const ny = nyDateISOAt(Date.now());
  const shift = (dateISO: string, days: number) => {
    const next = new Date(Date.UTC(+dateISO.slice(0, 4), +dateISO.slice(5, 7) - 1, +dateISO.slice(8, 10) + days));
    return next.toISOString().slice(0, 10);
  };

  it('accepts today in New York', () => {
    expect(transactionInputSchema.safeParse({ ...validPln, tradeDate: ny }).success).toBe(true);
  });

  it('accepts tomorrow, because a Warsaw evening is already the next day', () => {
    // The window is exactly the Warsaw/NY skew, and the iOS port and the
    // mobile contract share this schema — a tighter bound would reject a
    // legitimate entry from either client.
    expect(
      transactionInputSchema.safeParse({ ...validPln, tradeDate: shift(ny, 1) }).success,
    ).toBe(true);
  });

  it('rejects the day after that', () => {
    const result = transactionInputSchema.safeParse({ ...validPln, tradeDate: shift(ny, 2) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'tradeDate')).toBe(true);
    }
  });

  it('rejects the year typo the auditor found', () => {
    expect(
      transactionInputSchema.safeParse({ ...validPln, tradeDate: '2035-01-15' }).success,
    ).toBe(false);
  });
});

describe('targetPctSchema — a share, bounded like money is bounded', () => {
  const UUID = '7f1e0a54-3c1e-4d5f-9b2a-1c2d3e4f5a6b';

  it.each(['25', '0.5', '100', '12.75'])('accepts %s', (value) => {
    expect(targetPctSchema.safeParse(value).success).toBe(true);
  });

  it('normalises the pl-PL comma the way every other decimal field does', () => {
    expect(targetPctSchema.parse('12,5')).toBe('12.5');
  });

  it('refuses zero — "no target" is an ABSENT row, never a target of nothing', () => {
    // A stored `0` would read as a standing order to sell the whole
    // position, which is the opposite of "I have no opinion about this one".
    expect(targetPctSchema.safeParse('0').success).toBe(false);
  });

  it.each(['100.01', '25.123', 'abc', '', '-5', '1e2'])('refuses %s', (value) => {
    expect(targetPctSchema.safeParse(value).success).toBe(false);
  });

  it('reports a bad shape instead of throwing inside dec()', () => {
    // The regex gates the Decimal construction: zod runs every check even
    // after one fails, and `dec('abc')` throws rather than reporting.
    const result = targetPctSchema.safeParse('abc');
    expect(result.success).toBe(false);
  });

  it('accepts an empty list — clearing every target is a legal save', () => {
    expect(portfolioTargetsPutSchema.parse({ rows: [] }).rows).toEqual([]);
  });

  it('refuses the same instrument twice rather than silently keeping one', () => {
    expect(
      portfolioTargetsPutSchema.safeParse({
        rows: [
          { instrumentId: UUID, targetPct: '30' },
          { instrumentId: UUID, targetPct: '40' },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts distinct instruments and carries the normalised percents', () => {
    const parsed = portfolioTargetsPutSchema.parse({
      rows: [
        { instrumentId: UUID, targetPct: '30' },
        { instrumentId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', targetPct: '20,5' },
      ],
    });
    expect(parsed.rows.map((r) => r.targetPct)).toEqual(['30', '20.5']);
  });
});
