import { describe, expect, it } from 'vitest';

import {
  dec,
  directionOf,
  fmtMarketCap,
  fmtMoney,
  fmtPct,
  fmtQuantity,
  pctChange,
  splitMoney,
  toNumeric,
} from './money';

describe('dec', () => {
  it('keeps precision that a JS float would destroy', () => {
    // 0.1 + 0.2 === 0.30000000000000004 as floats.
    expect(dec('0.1').plus(dec('0.2')).equals(dec('0.3'))).toBe(true);
  });

  it('round-trips a numeric string without drift', () => {
    expect(toNumeric(dec('1234.56789012'))).toBe('1234.56789012');
  });
});

describe('pctChange', () => {
  it('computes a positive change', () => {
    expect(pctChange(dec('100'), dec('110'))!.toFixed(2)).toBe('10.00');
  });

  it('computes a negative change', () => {
    expect(pctChange(dec('100'), dec('90'))!.toFixed(2)).toBe('-10.00');
  });

  it('returns null rather than 0 when the base is zero', () => {
    // A zero base means "undefined", which must not render as a flat 0.00%.
    expect(pctChange(dec('0'), dec('10'))).toBeNull();
  });
});

describe('fmtPct', () => {
  it('signs gains explicitly', () => {
    expect(fmtPct(dec('3.456'))).toBe('+3,46%');
  });

  it('does not double-sign losses', () => {
    expect(fmtPct(dec('-3.456'))).toBe('-3,46%');
  });

  it('renders an em dash for an undefined change', () => {
    expect(fmtPct(null)).toBe('—');
  });

  it('treats exact zero as unsigned', () => {
    expect(fmtPct(dec('0'))).toBe('0,00%');
  });

  // The bug this formatter was changed for: a Holdings card prints the percent
  // immediately beside a pl-PL money string, so both must use the comma as the
  // decimal separator and U+00A0 as the group separator. A period here would
  // render "+20,46 zł (+51150.00%)" — two separators on one line.
  // Escapes, not literal spaces: both separators are U+00A0, which is
  // indistinguishable from a plain space in a diff and silently breaks the
  // assertion if someone retypes it.
  it('uses the same separators as fmtMoney', () => {
    expect(fmtPct(dec('51150'))).toBe('+51\u00a0150,00%');
    expect(fmtMoney(dec('23708.11'), 'PLN')).toBe('23\u00a0708,11\u00a0zł');
  });
});

// Polish CLDR carries `minimumGroupingDigits: 2`, so Intl's DEFAULT grouping
// leaves exactly the four-digit range bare — "+4550,59 zł" rendered one row
// above "45 500,59 zł". Four digits is the only width that regresses (five
// group with or without the fix), so it is the only width worth pinning.
// Escapes, not literal spaces, for the reason given above.
describe('thousands grouping', () => {
  it('groups four-digit values, which pl-PL would otherwise leave bare', () => {
    expect(fmtMoney(dec('4550.59'), 'PLN')).toBe('4\u00a0550,59\u00a0zł');
    expect(fmtQuantity(dec('1500'))).toBe('1\u00a0500');
    expect(fmtPct(dec('4550.59'))).toBe('+4\u00a0550,59%');
  });
});

describe('fmtMarketCap', () => {
  it('formats trillions with two decimals under 100 units', () => {
    expect(fmtMarketCap(dec('3.21e12'))).toBe('3,21T');
  });

  it('formats hundreds of billions with one decimal', () => {
    expect(fmtMarketCap(dec('8.452e11'))).toBe('845,2B');
  });

  it('uses M at the 999 million boundary', () => {
    expect(fmtMarketCap(dec('9.99e8'))).toBe('999,0M');
  });

  it('formats an exact trillion', () => {
    expect(fmtMarketCap(dec('1e12'))).toBe('1,00T');
  });

  it('groups a sub-million amount as an integer', () => {
    expect(fmtMarketCap(dec('4550'))).toBe('4\u00a0550');
  });

  it('never emits a digit-losing exponent', () => {
    expect(fmtMarketCap(dec('3.21e12'))).not.toMatch(/e/i);
    expect(fmtMarketCap(dec('1e12'))).not.toMatch(/e/i);
    expect(fmtMarketCap(dec('9.99e8'))).not.toMatch(/e/i);
  });

  it('bumps the suffix when rounding would print 1000 of the smaller unit', () => {
    // 999,95B at one decimal is 1 000,0B unless we re-scale to T.
    expect(fmtMarketCap(dec('9.9995e11'))).toBe('1,00T');
  });
});

describe('directionOf', () => {
  it('maps sign to a token name', () => {
    expect(directionOf(dec('1'))).toBe('gain');
    expect(directionOf(dec('-1'))).toBe('loss');
    expect(directionOf(dec('0'))).toBe('neutral');
    expect(directionOf(null)).toBe('neutral');
  });
});

describe('splitMoney — typesetting the currency apart from the number', () => {
  it('splits real fmtMoney output, including grouped amounts', () => {
    // The group separator is the SAME U+00A0 as the currency separator, so a
    // naive "first space" split would cut after "1" — this pins the last one.
    expect(splitMoney(fmtMoney(dec('1234567.5'), 'USD'))).toEqual({
      amount: fmtMoney(dec('1234567.5'), 'USD').slice(0, -4),
      currency: 'USD',
    });
    expect(splitMoney(fmtMoney(dec('231.1'), 'USD')).currency).toBe('USD');
    expect(splitMoney(fmtMoney(dec('231.1'), 'PLN')).currency).toBe('zł');
    expect(splitMoney(fmtMoney(dec('-231.1'), 'USD')).currency).toBe('USD');
  });

  it('rejoins to exactly the original string — nothing is lost in the split', () => {
    for (const currency of ['USD', 'PLN', 'EUR', 'GBP']) {
      const formatted = fmtMoney(dec('9876543.21'), currency);
      const { amount, currency: unit } = splitMoney(formatted);
      expect(`${amount}${formatted.slice(amount.length, formatted.length - unit.length)}${unit}`)
        .toBe(formatted);
    }
  });

  it('a figure with no currency token comes back whole', () => {
    // The unpriced case: callers render '—' through the same path.
    expect(splitMoney('—')).toEqual({ amount: '—', currency: '' });
  });
});
