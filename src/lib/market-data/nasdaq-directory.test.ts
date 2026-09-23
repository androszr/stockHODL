import { describe, expect, it } from 'vitest';

import {
  denormalizeDirectorySymbol,
  escapeLikePattern,
  hasExactSymbolMatch,
  mergeSymbolMatches,
  normalizeDirectorySymbol,
  parseNasdaqDirectory,
  rankDirectoryMatches,
  type DirectoryRow,
} from './nasdaq-directory';
import type { SymbolMatch } from './symbol-search';

/**
 * Fixture mirrors the real `nasdaqtraded.txt` shape exactly: pipe-delimited,
 * 12 columns, header row, trailing `File Creation Time` line. Zero network.
 */

const HEADER =
  'Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|' +
  'Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares';

const TRAILER = 'File Creation Time: 0808202520:30|||||||||||';

function row({
  symbol,
  name,
  exchange = 'N',
  etf = 'N',
  testIssue = 'N',
}: {
  symbol: string;
  name: string;
  exchange?: string;
  etf?: string;
  testIssue?: string;
}): string {
  return `Y|${symbol}|${name}|${exchange}| |${etf}|100|${testIssue}||${symbol}|${symbol}|N`;
}

function fixture(...lines: string[]): string {
  return [HEADER, ...lines, TRAILER, ''].join('\n');
}

describe('parseNasdaqDirectory', () => {
  it('skips the header row', () => {
    const rows = parseNasdaqDirectory(fixture(row({ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'Q' })));
    expect(rows).toHaveLength(1);
    expect(rows.map((r) => r.symbol)).not.toContain('Symbol');
  });

  it('skips the trailing File Creation Time line', () => {
    const rows = parseNasdaqDirectory(fixture());
    expect(rows).toHaveLength(0);
  });

  it('tolerates a blank final line', () => {
    const text = fixture(row({ symbol: 'A', name: 'Agilent' })) + '\n\n';
    expect(parseNasdaqDirectory(text)).toHaveLength(1);
  });

  it('excludes Test Issue = Y rows', () => {
    const rows = parseNasdaqDirectory(
      fixture(
        row({ symbol: 'ZTEST', name: 'Test Security', testIssue: 'Y' }),
        row({ symbol: 'REAL', name: 'Real Security' }),
      ),
    );
    expect(rows.map((r) => r.symbol)).toEqual(['REAL']);
  });

  it('maps ETF = Y to type etf', () => {
    const [voo] = parseNasdaqDirectory(
      fixture(row({ symbol: 'VOO', name: 'Vanguard S&P 500 ETF', exchange: 'P', etf: 'Y' })),
    );
    expect(voo.type).toBe('etf');
  });

  it('maps ETF = N to type equity', () => {
    const [nke] = parseNasdaqDirectory(fixture(row({ symbol: 'NKE', name: 'Nike, Inc.' })));
    expect(nke.type).toBe('equity');
  });

  it.each([
    ['N', 'NYSE'],
    ['Q', 'Nasdaq'],
    ['A', 'NYSE American'],
    ['P', 'NYSE Arca'],
    ['Z', 'Cboe BZX'],
    ['V', 'IEX'],
  ])('maps Listing Exchange code %s to %s', (code, display) => {
    const [parsed] = parseNasdaqDirectory(
      fixture(row({ symbol: 'X', name: 'Example Corp', exchange: code })),
    );
    expect(parsed.exchange).toBe(display);
  });

  it('drops rows with an unknown exchange code', () => {
    const rows = parseNasdaqDirectory(
      fixture(row({ symbol: 'WEIRD', name: 'Unknown Venue Corp', exchange: '?' })),
    );
    expect(rows).toHaveLength(0);
  });

  it('parses the documented Agilent example row', () => {
    const rows = parseNasdaqDirectory(
      fixture('Y|A|Agilent Technologies, Inc. Common Stock|N| |N|100|N||A|A|N'),
    );
    expect(rows).toEqual([
      {
        symbol: 'A',
        name: 'Agilent Technologies, Inc. Common Stock',
        exchange: 'NYSE',
        type: 'equity',
      },
    ]);
  });

  it('normalizes class-share slashes to the provider dot convention', () => {
    // The file spells class shares `BRK/A`; the quote provider answers only
    // `BRK.A`. instruments is first-write-wins, so the directory must emit
    // the spelling getQuotes will later request.
    const [brk] = parseNasdaqDirectory(
      fixture(row({ symbol: 'BRK/A', name: 'Berkshire Hathaway Inc. Class A' })),
    );
    expect(brk.symbol).toBe('BRK.A');
  });

  it('drops rows missing a symbol or name', () => {
    const rows = parseNasdaqDirectory(
      fixture(row({ symbol: '', name: 'No Symbol Corp' }), row({ symbol: 'NONAME', name: '' })),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('rankDirectoryMatches', () => {
  const rows: DirectoryRow[] = [
    { symbol: 'AAPL', name: 'Apple Inc. Common Stock', exchange: 'Nasdaq', type: 'equity' },
    { symbol: 'AAPB', name: 'GraniteShares 2x Long AAPL Daily ETF', exchange: 'Nasdaq', type: 'etf' },
    { symbol: 'APLE', name: 'Apple Hospitality REIT, Inc.', exchange: 'NYSE', type: 'equity' },
    { symbol: 'PINE', name: 'Alpine Income Property Trust', exchange: 'NYSE', type: 'equity' },
  ];

  it('ranks exact symbol above prefix above name-substring', () => {
    const matches = rankDirectoryMatches('AAPL', rows);
    // AAPL exact; AAPB is no prefix of "aapl"… but "aapl" prefixes nothing else,
    // so the substring bucket catches AAPB via its name.
    expect(matches[0].symbol).toBe('AAPL');
    expect(matches.map((m) => m.symbol)).toEqual(['AAPL', 'AAPB']);
  });

  it('puts symbol-prefix matches ahead of name matches, alphabetically within each bucket', () => {
    const matches = rankDirectoryMatches('AAP', rows);
    expect(matches.map((m) => m.symbol)).toEqual(['AAPB', 'AAPL']);

    const apple = rankDirectoryMatches('apple', rows);
    // No symbol is or starts with "apple", so both hits are name-substring,
    // alphabetical by symbol.
    expect(apple.map((m) => m.symbol)).toEqual(['AAPL', 'APLE']);
  });

  it('is case-insensitive: aapl finds AAPL', () => {
    expect(rankDirectoryMatches('aapl', rows)[0]?.symbol).toBe('AAPL');
  });

  it('treats % and _ as literals, never wildcards', () => {
    expect(rankDirectoryMatches('%', rows)).toHaveLength(0);
    expect(rankDirectoryMatches('A_PL', rows)).toHaveLength(0);
    expect(rankDirectoryMatches('AAP%', rows)).toHaveLength(0);
  });

  it('emits SymbolMatch with USD currency and exchange === exchangeDisplay', () => {
    const [match] = rankDirectoryMatches('AAPL', rows);
    expect(match).toEqual({
      symbol: 'AAPL',
      name: 'Apple Inc. Common Stock',
      exchange: 'Nasdaq',
      exchangeDisplay: 'Nasdaq',
      type: 'equity',
      currency: 'USD',
    });
  });

  it('returns nothing for an empty or whitespace query', () => {
    expect(rankDirectoryMatches('', rows)).toHaveLength(0);
    expect(rankDirectoryMatches('   ', rows)).toHaveLength(0);
  });
});

describe('escapeLikePattern', () => {
  it('escapes %, _ and backslash', () => {
    expect(escapeLikePattern('100%_\\')).toBe('100\\%\\_\\\\');
  });

  it('leaves ordinary queries untouched', () => {
    expect(escapeLikePattern('BRK/A')).toBe('BRK/A');
    expect(escapeLikePattern('nike')).toBe('nike');
  });
});

describe('normalizeDirectorySymbol', () => {
  it('rewrites class-share slashes to dots', () => {
    expect(normalizeDirectorySymbol('BRK/A')).toBe('BRK.A');
    expect(normalizeDirectorySymbol('BRK/B')).toBe('BRK.B');
  });

  it('leaves plain and already-dotted symbols alone', () => {
    expect(normalizeDirectorySymbol('AAPL')).toBe('AAPL');
    expect(normalizeDirectorySymbol('BRK.A')).toBe('BRK.A');
  });
});

describe('denormalizeDirectorySymbol', () => {
  it('rewrites provider dots back to the legacy slash form', () => {
    expect(denormalizeDirectorySymbol('BRK.A')).toBe('BRK/A');
    expect(denormalizeDirectorySymbol('BRK.B')).toBe('BRK/B');
  });

  it('round-trips with normalizeDirectorySymbol', () => {
    expect(normalizeDirectorySymbol(denormalizeDirectorySymbol('BRK.A'))).toBe('BRK.A');
    expect(denormalizeDirectorySymbol(normalizeDirectorySymbol('BRK/A'))).toBe('BRK/A');
  });

  it('is a no-op on symbols without a class-share separator', () => {
    expect(denormalizeDirectorySymbol('AAPL')).toBe('AAPL');
  });
});

/** SymbolMatch fixture in the shape both search sources emit. */
function match(symbol: string, name: string, type: 'equity' | 'etf' = 'equity'): SymbolMatch {
  return {
    symbol,
    name,
    exchange: 'NYSE',
    exchangeDisplay: 'NYSE',
    type,
    currency: 'USD',
  };
}

describe('hasExactSymbolMatch', () => {
  const results = [match('GOGL', 'Golden Ocean Group'), match('GOOS', 'Canada Goose Holdings')];

  it('is true only when a symbol equals the query, case-insensitively', () => {
    expect(hasExactSymbolMatch('GOGL', results)).toBe(true);
    expect(hasExactSymbolMatch('gogl', results)).toBe(true);
    expect(hasExactSymbolMatch('GO', results)).toBe(false);
  });

  it('is false for empty queries and empty result sets', () => {
    expect(hasExactSymbolMatch('', results)).toBe(false);
    expect(hasExactSymbolMatch('   ', results)).toBe(false);
    expect(hasExactSymbolMatch('GO', [])).toBe(false);
  });
});

describe('mergeSymbolMatches', () => {
  it('surfaces an exact ticker the provider window omitted — GO ranks first', () => {
    // The vendor's ticker-ascending window over ticker-OR-name matches can
    // fill every slot with alphabetically earlier NAME matches ("go" appears
    // in many company names) before the exact ticker GO is reached.
    const primary = [
      match('ARGO', 'Argo Blockchain plc'),
      match('CARG', 'Cargo Therapeutics, Inc.'),
      match('GOGL', 'Golden Ocean Group'),
    ];
    const fallback = [match('GO', 'Grocery Outlet Holding Corp.'), match('GOGL', 'Golden Ocean Group')];

    const merged = mergeSymbolMatches('GO', primary, fallback);
    expect(merged[0]?.symbol).toBe('GO');
    // Prefix matches beat name-substring matches, and nothing is duplicated.
    expect(merged.map((m) => m.symbol)).toEqual(['GO', 'GOGL', 'ARGO', 'CARG']);
  });

  it('dedupes by symbol with the provider entry winning', () => {
    const primary = [match('NKE', 'Nike, Inc. (provider naming)')];
    const fallback = [match('NKE', 'Nike, Inc. Common Stock')];

    const merged = mergeSymbolMatches('NKE', primary, fallback);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('Nike, Inc. (provider naming)');
  });

  it('with an empty primary it is a plain re-rank of the fallback (degraded path)', () => {
    const fallback = [match('AAPB', 'GraniteShares 2x Long AAPL Daily ETF', 'etf'), match('AAPL', 'Apple Inc.')];
    const merged = mergeSymbolMatches('AAPL', [], fallback);
    expect(merged.map((m) => m.symbol)).toEqual(['AAPL', 'AAPB']);
  });

  it('keeps the SymbolMatch shape intact — currency USD, display exchange', () => {
    const merged = mergeSymbolMatches('GO', [], [match('GO', 'Grocery Outlet Holding Corp.')]);
    expect(merged[0]).toEqual({
      symbol: 'GO',
      name: 'Grocery Outlet Holding Corp.',
      exchange: 'NYSE',
      exchangeDisplay: 'NYSE',
      type: 'equity',
      currency: 'USD',
    });
  });
});
