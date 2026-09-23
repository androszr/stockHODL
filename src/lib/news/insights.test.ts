import { describe, expect, it } from 'vitest';

import { parseNewsInsights, parseNewsKeywords } from './insights';

describe('parseNewsInsights', () => {
  it('parses observed entries and keeps unknown sentiment words verbatim', () => {
    expect(
      parseNewsInsights([
        { ticker: 'MU', sentiment: 'positive', sentiment_reasoning: 'demand' },
        { ticker: 'AAPL', sentiment: 'somewhat-bullish' },
      ]),
    ).toEqual([
      { ticker: 'MU', sentiment: 'positive' },
      { ticker: 'AAPL', sentiment: 'somewhat-bullish' },
    ]);
  });

  it('survives an entry with only a ticker', () => {
    expect(parseNewsInsights([{ ticker: 'MU' }])).toEqual([{ ticker: 'MU', sentiment: null }]);
  });

  it('drops malformed entries instead of throwing', () => {
    expect(
      parseNewsInsights([
        null,
        42,
        'text',
        {},
        { ticker: 7 },
        { ticker: '' },
        { ticker: 'OK', sentiment: 3 },
      ]),
    ).toEqual([{ ticker: 'OK', sentiment: null }]);
  });

  it('returns empty for non-array jsonb', () => {
    expect(parseNewsInsights(null)).toEqual([]);
    expect(parseNewsInsights({ ticker: 'MU' })).toEqual([]);
    expect(parseNewsInsights('MU')).toEqual([]);
  });

  it('dedupes tickers case-insensitively, first entry wins', () => {
    expect(
      parseNewsInsights([
        { ticker: 'mu', sentiment: 'positive' },
        { ticker: 'MU', sentiment: 'negative' },
      ]),
    ).toEqual([{ ticker: 'MU', sentiment: 'positive' }]);
  });
});

describe('parseNewsKeywords', () => {
  it('keeps strings and drops everything else', () => {
    expect(parseNewsKeywords(['ai', 42, null, '', 'chips'])).toEqual(['ai', 'chips']);
  });

  it('returns empty for non-array jsonb', () => {
    expect(parseNewsKeywords(null)).toEqual([]);
    expect(parseNewsKeywords('ai')).toEqual([]);
  });
});
