import { describe, expect, it } from 'vitest';

import {
  mapNewsResults,
  newsParams,
  newsResponseSchema,
  type NewsResult,
} from './massive-mapping';

// The shape observed live 2026-08-16 — every field the vendor sent.
const FULL_RESULT = {
  id: 'c198cd1d6f404e667860bbac64107e6c090a6cb871e17a06dec1001e2fdff136',
  publisher: {
    name: 'The Motley Fool',
    homepage_url: 'https://www.fool.com/',
    logo_url: 'https://example.com/logo.svg',
    favicon_url: 'https://example.com/favicon.ico',
  },
  title: 'Memory stocks are on fire',
  author: 'A Writer',
  published_utc: '2026-08-16T06:30:00Z',
  article_url: 'https://www.fool.com/investing/2026/08/16/memory-stocks/',
  tickers: ['MU', 'aapl', 'MU'],
  image_url: 'https://g.foolcdn.com/image/hero.jpg',
  description: 'A short AI summary of the piece.',
  keywords: ['semiconductors', 'memory'],
  insights: [{ ticker: 'MU', sentiment: 'positive', sentiment_reasoning: 'Strong demand.' }],
};

describe('newsResponseSchema', () => {
  it('parses the observed envelope including next_url', () => {
    const parsed = newsResponseSchema.safeParse({
      results: [FULL_RESULT],
      status: 'OK',
      request_id: 'abc',
      count: 1,
      // A representative cursor URL — deliberately NOT the real vendor host or
      // path: those two strings are grep-fenced to massive.ts (and the stream).
      next_url: 'https://vendor.example/v2/news-feed?cursor=xyz',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.results).toHaveLength(1);
    expect(parsed.data.next_url).toContain('cursor=xyz');
  });

  it('tolerates unknown extra fields on results and envelope', () => {
    const parsed = newsResponseSchema.safeParse({
      results: [{ ...FULL_RESULT, brand_new_field: { nested: true } }],
      some_new_envelope_key: 42,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('newsParams', () => {
  it('sends exactly the two live-verified params: single-symbol ticker + limit', () => {
    const params = newsParams('LULU', 10);
    expect(params.get('ticker')).toBe('LULU');
    expect(params.get('limit')).toBe('10');
    expect([...params.keys()].sort()).toEqual(['limit', 'ticker']);
    // The retired multi-symbol parameter must be gone — spelled split so a
    // plain grep of this file finds no mention of it (acceptance criterion).
    expect(params.get(`ticker.any${'_of'}`)).toBeNull();
  });

  it('passes the symbol through verbatim — no join, no array handling', () => {
    // The vendor ignores every multi-symbol parameter form and returns 0
    // results for a comma list on `ticker` (verified live 2026-08-16) — this
    // pins that the builder cannot even express a joined request.
    const params = newsParams('BRK.A', 10);
    expect(params.get('ticker')).toBe('BRK.A');
    expect(params.toString()).not.toContain('%2C'); // no comma ever encoded
  });
});

describe('mapNewsResults', () => {
  it('maps a fully-populated result verbatim', () => {
    const [article] = mapNewsResults([FULL_RESULT as NewsResult]);
    expect(article).toBeDefined();
    expect(article.id).toBe(FULL_RESULT.id);
    expect(article.title).toBe(FULL_RESULT.title);
    expect(article.articleUrl).toBe(FULL_RESULT.article_url);
    expect(article.publishedAtMs).toBe(Date.parse('2026-08-16T06:30:00Z'));
    expect(article.author).toBe('A Writer');
    expect(article.publisherName).toBe('The Motley Fool');
    expect(article.publisherHomepage).toBe('https://www.fool.com/');
    // Stored VERBATIM — the proxy route enforces origin/scheme/content-type
    // at fetch time, deliberately not the mapper.
    expect(article.publisherLogoUrl).toBe('https://example.com/logo.svg');
    expect(article.publisherFaviconUrl).toBe('https://example.com/favicon.ico');
    expect(article.imageUrl).toBe(FULL_RESULT.image_url);
    expect(article.description).toBe(FULL_RESULT.description);
    // Uppercased and deduped for the join table.
    expect(article.tickers).toEqual(['MU', 'AAPL']);
    expect(article.keywords).toEqual(['semiconductors', 'memory']);
    expect(article.insights).toEqual(FULL_RESULT.insights);
  });

  it.each(['id', 'title', 'article_url', 'published_utc'] as const)(
    'drops (never throws on) a result missing %s',
    (field) => {
      const partial: Record<string, unknown> = { ...FULL_RESULT };
      delete partial[field];
      expect(mapNewsResults([partial as NewsResult])).toEqual([]);
    },
  );

  // The clicked URL is rendered straight into an href and the row is immutable
  // for 90 days, so a non-https scheme is dropped at the boundary rather than
  // trusted to React's href warning.
  it.each(['javascript:alert(1)', 'data:text/html,<script>x</script>', 'http://fool.com/a'])(
    'drops a result whose article_url is %s',
    (url) => {
      expect(mapNewsResults([{ ...FULL_RESULT, article_url: url } as NewsResult])).toEqual([]);
    },
  );

  it('drops a result whose published_utc does not parse', () => {
    const bad = { ...FULL_RESULT, published_utc: 'not-a-date' };
    expect(mapNewsResults([bad as NewsResult])).toEqual([]);
  });

  it('keeps optional fields null/empty when absent', () => {
    const minimal = {
      id: 'abcd1234',
      title: 'Bare minimum',
      article_url: 'https://example.com/a',
      published_utc: '2026-08-15T00:00:00Z',
    };
    const [article] = mapNewsResults([minimal as NewsResult]);
    expect(article.author).toBeNull();
    expect(article.publisherName).toBeNull();
    expect(article.publisherHomepage).toBeNull();
    expect(article.publisherLogoUrl).toBeNull();
    expect(article.publisherFaviconUrl).toBeNull();
    expect(article.imageUrl).toBeNull();
    expect(article.description).toBeNull();
    expect(article.tickers).toEqual([]);
    expect(article.keywords).toBeNull();
    expect(article.insights).toBeNull();
  });

  it('a publisher with only one asset URL maps that one and nulls the other', () => {
    const logoOnly = {
      ...FULL_RESULT,
      publisher: { name: 'Benzinga', logo_url: 'https://example.com/benzinga.png' },
    };
    const [a] = mapNewsResults([logoOnly as NewsResult]);
    expect(a.publisherLogoUrl).toBe('https://example.com/benzinga.png');
    expect(a.publisherFaviconUrl).toBeNull();

    const faviconOnly = {
      ...FULL_RESULT,
      publisher: { name: 'Benzinga', favicon_url: 'https://example.com/favicon.ico' },
    };
    const [b] = mapNewsResults([faviconOnly as NewsResult]);
    expect(b.publisherLogoUrl).toBeNull();
    expect(b.publisherFaviconUrl).toBe('https://example.com/favicon.ico');
  });

  it('an absent publisher object nulls both URLs', () => {
    const noPublisher: Record<string, unknown> = { ...FULL_RESULT };
    delete noPublisher.publisher;
    const [article] = mapNewsResults([noPublisher as NewsResult]);
    expect(article.publisherLogoUrl).toBeNull();
    expect(article.publisherFaviconUrl).toBeNull();
  });

  it('passes an insights entry with only a ticker through untouched', () => {
    const result = { ...FULL_RESULT, insights: [{ ticker: 'MU' }] };
    const parsed = newsResponseSchema.safeParse({ results: [result] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const [article] = mapNewsResults(parsed.data.results ?? []);
    expect(article.insights).toEqual([{ ticker: 'MU' }]);
  });
});
