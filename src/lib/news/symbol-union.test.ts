import { describe, expect, it } from 'vitest';

import { buildNewsSymbolUnion, MAX_NEWS_SYMBOLS, resolveKnownSymbol } from './symbol-union';

describe('buildNewsSymbolUnion', () => {
  it('dedupes a symbol appearing in every source', () => {
    const union = buildNewsSymbolUnion({
      watched: ['AAPL', 'MSFT'],
      held: ['AAPL', 'NVDA'],
      optionUnderlyings: ['AAPL', 'CRM'],
    });
    expect(union.symbols).toEqual(['AAPL', 'MSFT', 'NVDA', 'CRM']);
    expect(union.omitted).toEqual([]);
  });

  it('keeps priority order watched → held → underlyings under the cap', () => {
    const union = buildNewsSymbolUnion({
      watched: ['ZTS'],
      held: ['AAPL'],
      optionUnderlyings: ['CRM'],
    });
    // Watched first even though it sorts last alphabetically.
    expect(union.symbols).toEqual(['ZTS', 'AAPL', 'CRM']);
  });

  it('caps at exactly MAX_NEWS_SYMBOLS and names the overflow in omitted', () => {
    const watched = Array.from({ length: MAX_NEWS_SYMBOLS + 3 }, (_, i) => `SYM${i}`);
    const union = buildNewsSymbolUnion({ watched, held: [], optionUnderlyings: [] });
    expect(union.symbols).toHaveLength(MAX_NEWS_SYMBOLS);
    expect(union.symbols[0]).toBe('SYM0');
    expect(union.symbols[MAX_NEWS_SYMBOLS - 1]).toBe(`SYM${MAX_NEWS_SYMBOLS - 1}`);
    // The 51st+ are NAMED, never silently dropped.
    expect(union.omitted).toEqual([
      `SYM${MAX_NEWS_SYMBOLS}`,
      `SYM${MAX_NEWS_SYMBOLS + 1}`,
      `SYM${MAX_NEWS_SYMBOLS + 2}`,
    ]);
  });

  it('lower-priority sources overflow first when the cap bites', () => {
    const watched = Array.from({ length: MAX_NEWS_SYMBOLS }, (_, i) => `W${i}`);
    const union = buildNewsSymbolUnion({
      watched,
      held: ['HELD1'],
      optionUnderlyings: ['UND1'],
    });
    expect(union.symbols).toEqual(watched);
    expect(union.omitted).toEqual(['HELD1', 'UND1']);
  });

  it('returns an empty union for empty inputs — no vendor call implied', () => {
    const union = buildNewsSymbolUnion({ watched: [], held: [], optionUnderlyings: [] });
    expect(union.symbols).toEqual([]);
    expect(union.omitted).toEqual([]);
  });

  it('collapses case variants and duplicates to one uppercase symbol', () => {
    const union = buildNewsSymbolUnion({
      watched: ['aapl', 'AAPL', ' Aapl '],
      held: ['aApL'],
      optionUnderlyings: [],
    });
    expect(union.symbols).toEqual(['AAPL']);
    expect(union.omitted).toEqual([]);
  });

  it('drops empty and whitespace-only entries', () => {
    const union = buildNewsSymbolUnion({
      watched: ['', '  ', 'MSFT'],
      held: [],
      optionUnderlyings: [],
    });
    expect(union.symbols).toEqual(['MSFT']);
  });
});

describe('resolveKnownSymbol', () => {
  const sources = {
    watched: ['AAPL', 'BRK.A'],
    held: ['MSFT'],
    optionUnderlyings: ['NVDA'],
  };

  it('resolves a symbol from each of the three sources', () => {
    expect(resolveKnownSymbol('AAPL', sources)).toBe('AAPL');
    expect(resolveKnownSymbol('MSFT', sources)).toBe('MSFT');
    expect(resolveKnownSymbol('NVDA', sources)).toBe('NVDA');
  });

  it('resolves case-insensitively to the uppercase symbol', () => {
    expect(resolveKnownSymbol('aapl', sources)).toBe('AAPL');
    expect(resolveKnownSymbol(' msft ', sources)).toBe('MSFT');
  });

  it('handles dot-notation class-share tickers', () => {
    expect(resolveKnownSymbol('brk.a', sources)).toBe('BRK.A');
  });

  it('returns null for an unknown symbol — foreign and gibberish alike', () => {
    expect(resolveKnownSymbol('TSLA', sources)).toBeNull();
    expect(resolveKnownSymbol('ZZZNOTMINE', sources)).toBeNull();
  });

  it('returns null for empty and whitespace-only input', () => {
    expect(resolveKnownSymbol('', sources)).toBeNull();
    expect(resolveKnownSymbol('   ', sources)).toBeNull();
  });

  it('resolves a symbol present in several sources exactly once, to one value', () => {
    expect(
      resolveKnownSymbol('AAPL', {
        watched: ['AAPL'],
        held: ['aapl'],
        optionUnderlyings: ['Aapl'],
      }),
    ).toBe('AAPL');
  });

  it('matches against un-normalized source entries', () => {
    expect(
      resolveKnownSymbol('aapl', { watched: [' aapl '], held: [], optionUnderlyings: [] }),
    ).toBe('AAPL');
  });

  it('resolves a closed-out position via transacted — held no longer, traded ever', () => {
    // The /holdings/[ticker] owned branch renders for ANY transaction
    // history, so a fully-sold symbol must still resolve for its own page.
    expect(
      resolveKnownSymbol('SOLD', {
        watched: [],
        held: [],
        optionUnderlyings: [],
        transacted: ['SOLD'],
      }),
    ).toBe('SOLD');
    expect(
      resolveKnownSymbol('sold', {
        watched: [],
        held: [],
        optionUnderlyings: [],
        transacted: [' Sold '],
      }),
    ).toBe('SOLD');
  });

  it('still refuses an unknown symbol when transacted is present', () => {
    expect(
      resolveKnownSymbol('TSLA', {
        watched: ['AAPL'],
        held: [],
        optionUnderlyings: [],
        transacted: ['SOLD'],
      }),
    ).toBeNull();
  });

  it('transacted never widens the union feed — buildNewsSymbolUnion ignores it', () => {
    const sources = {
      watched: ['AAPL'],
      held: [],
      optionUnderlyings: [],
      transacted: ['SOLD'],
    };
    const union = buildNewsSymbolUnion(sources);
    expect(union.symbols).toEqual(['AAPL']);
    expect(union.omitted).toEqual([]);
  });
});
