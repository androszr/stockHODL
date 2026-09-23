import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Loader-level tests for `loadTickerNews` / `loadNewsFeed` with the database
 * and vendor boundaries mocked out (the `watchlist/actions.test.ts` pattern).
 * What is real: `resolveKnownSymbol`, `buildNewsSymbolUnion` and the position
 * engine — the authorization walk these tests exist to pin.
 *
 * The behaviors under pin:
 * 1. CLOSED-OUT ELIGIBILITY — a symbol with transaction history but zero
 *    open quantity still resolves for its own page (`/holdings/[ticker]`
 *    renders for any transacted symbol), while the union feed stays narrow
 *    and never absorbs it.
 * 2. FAIL CLOSED — a failure BEFORE `resolveKnownSymbol` completes returns
 *    `null` (never authorized), never the degraded-empty shape; only a
 *    failure AFTER validation degrades.
 * 3. PER-SYMBOL FAN-OUT (2026-08-16, fix-news-ticker-filter plan) — one
 *    vendor request per symbol, never a joined list (the vendor returns 0
 *    results for `ticker=A,B` and silently ignores every multi-symbol
 *    parameter form); bounded concurrency, capped request count, id-dedupe
 *    before persisting, partial-failure tolerance with the degraded flag
 *    raised only past the failure ratio or on a failed store write.
 */

const h = vi.hoisted(() => ({
  /** One entry per AWAITED query, in await order. Sub-queries built as
   *  `inArray` arguments are never awaited and consume nothing. */
  queue: [] as Array<{ value?: unknown; error?: unknown }>,
  getNewsArticles: vi.fn(),
  persistArticles: vi.fn(),
  pruneOldArticles: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@/lib/market-data/massive', () => ({
  getNewsArticles: h.getNewsArticles,
  // Stand-in for the servability pre-check (its real cases live in
  // massive.test.ts): stringly-present and not svg. The mock rows here omit
  // the publisher URL columns entirely, so `undefined` must read as false.
  isServablePublisherAssetUrl: (url: unknown) =>
    typeof url === 'string' && !url.toLowerCase().endsWith('.svg'),
}));
vi.mock('./store', () => ({
  persistArticles: h.persistArticles,
  pruneOldArticles: h.pruneOldArticles,
}));
vi.mock('@/lib/db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) {
      chain[m] = vi.fn(self);
    }
    // Thenable: awaiting any chain consumes the next queued result.
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const next = h.queue.shift();
      if (next === undefined) {
        return Promise.reject(new Error('unexpected query — queue empty')).then(resolve, reject);
      }
      if (next.error !== undefined) return Promise.reject(next.error).then(resolve, reject);
      return Promise.resolve(next.value).then(resolve, reject);
    };
    return chain;
  };
  return {
    db: {
      select: vi.fn(() => makeChain()),
      selectDistinct: vi.fn(() => makeChain()),
    },
    instruments: {},
    newsArticles: {},
    newsArticleTickers: {},
    optionPositions: {},
    portfolios: {},
    transactions: {},
    watchlist: {},
  };
});

import { loadNewsFeed, loadTickerNews } from './feed';

const USER = 'user-1';

/** A buy/sell pair that nets SOLD's quantity to exactly zero. */
function closedOutTxRows(symbol = 'SOLD') {
  const base = {
    instrumentId: 'inst-1',
    symbol,
    displayName: 'Sold Out Inc.',
    currency: 'USD',
    price: '10.00',
    fees: '0',
    fxRateToBase: '4.00',
  };
  return [
    {
      ...base,
      id: 'tx-1',
      side: 'buy',
      quantity: '10',
      tradeDate: '2026-01-05',
      createdAt: new Date('2026-01-05T10:00:00Z'),
    },
    {
      ...base,
      id: 'tx-2',
      side: 'sell',
      quantity: '10',
      tradeDate: '2026-02-05',
      createdAt: new Date('2026-02-05T10:00:00Z'),
    },
  ];
}

function articleRows(ids: string[], ms = Date.parse('2026-08-15T12:00:00Z')) {
  return ids.map((id, i) => ({
    id,
    title: `Story ${id}`,
    publisherName: null,
    publishedAt: new Date(ms - i * 60_000),
    imageUrl: null,
  }));
}

beforeEach(() => {
  h.queue.length = 0;
  vi.clearAllMocks();
  // Full reset (an implementation set inside one test must not leak into the
  // next), then the healthy defaults: no stories, a committed write.
  h.getNewsArticles.mockReset().mockResolvedValue([]);
  h.persistArticles.mockReset().mockResolvedValue(true);
  h.pruneOldArticles.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(h.queue).toHaveLength(0); // every test accounts for every query
});

describe('loadTickerNews — closed-out positions stay eligible', () => {
  it('resolves a symbol with zero open quantity via its transaction history', async () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    h.queue.push(
      { value: [] }, // watched
      { value: closedOutTxRows() }, // transactions → held = [], transacted = ['SOLD']
      { value: [] }, // option underlyings
      { value: articleRows(ids) }, // stored rows — ≥ 5, so no thin-path refresh
      { value: ids.map((id) => ({ articleId: id, ticker: 'SOLD' })) }, // chip join
    );

    const news = await loadTickerNews(USER, 'SOLD', 5);
    expect(news).not.toBeNull();
    expect(news?.articles).toHaveLength(5);
    expect(news?.degraded).toBe(false);
    // Its own surface names it, union membership or not.
    expect(news?.articles[0]?.matchedTickers).toEqual(['SOLD']);
    // ≥ 5 stored rows — the vendor was never asked.
    expect(h.getNewsArticles).not.toHaveBeenCalled();
  });

  it('keeps the union feed narrow — a transacted-only symbol implies no vendor call', async () => {
    h.queue.push(
      { value: [] }, // watched
      { value: closedOutTxRows() }, // held = []
      { value: [] }, // option underlyings
    );

    const feed = await loadNewsFeed(USER, 50);
    // Empty union: the feed answers empty WITHOUT touching vendor or store —
    // ever-transacted symbols must not leak into the capped union.
    expect(feed).toEqual({ articles: [], omitted: [], degraded: false });
    expect(h.getNewsArticles).not.toHaveBeenCalled();
  });
});

describe('loadTickerNews — authorization fails closed', () => {
  it('returns null (not degraded-empty) when the context read fails before validation', async () => {
    h.queue.push({ error: new Error('db unreachable') });

    const news = await loadTickerNews(USER, 'ZZZNOTMINE', 50);
    // Never validated → never authorized: a transient failure must not dress
    // an unchecked candidate up as "yours", even as a degraded-empty frame.
    expect(news).toBeNull();
    expect(h.getNewsArticles).not.toHaveBeenCalled();
  });

  it('returns degraded-empty when a failure happens after validation succeeded', async () => {
    h.queue.push(
      { value: [{ symbol: 'AAPL' }] }, // watched — validates the candidate
      { value: [] }, // transactions
      { value: [] }, // option underlyings
      { error: new Error('read failed') }, // stored-rows read
    );

    const news = await loadTickerNews(USER, 'AAPL', 5);
    expect(news).toEqual({ articles: [], degraded: true });
  });

  it('returns null for a candidate outside every source, with a healthy context', async () => {
    h.queue.push(
      { value: [{ symbol: 'AAPL' }] }, // watched
      { value: closedOutTxRows() }, // transacted = ['SOLD']
      { value: [] }, // option underlyings
    );

    const news = await loadTickerNews(USER, 'TSLA', 5);
    expect(news).toBeNull();
    expect(h.getNewsArticles).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * The per-symbol fan-out (fix-news-ticker-filter). The refresh cache is
 * module-level and keyed by the sorted symbol set, so every test below
 * uses symbols no other test touches — a repeat set would hit the TTL
 * and skip the vendor entirely.
 * ------------------------------------------------------------------ */

/** Queue the three symbol-context reads (watched only) + the feed's
 *  stored-rows read (empty — no chip join follows). */
function queueFeedWalk(watchedSymbols: string[]) {
  h.queue.push(
    { value: watchedSymbols.map((symbol) => ({ symbol })) }, // watched
    { value: [] }, // transactions
    { value: [] }, // option underlyings
    { value: [] }, // stored-rows read (empty → no chip join query)
  );
}

describe('loadNewsFeed — per-symbol fan-out', () => {
  it('asks the vendor once per union symbol, never with a joined string', async () => {
    queueFeedWalk(['AAA', 'BBB', 'CCC']);

    const feed = await loadNewsFeed(USER, 50);
    expect(feed.degraded).toBe(false);
    expect(h.getNewsArticles).toHaveBeenCalledTimes(3);
    const calls = h.getNewsArticles.mock.calls as Array<[string, number]>;
    expect(calls.map(([symbol]) => symbol).sort()).toEqual(['AAA', 'BBB', 'CCC']);
    for (const [symbol, limit] of calls) {
      // `ticker=A,B` returns 0 results at the vendor — a joined request is
      // the silent-empty-feed bug this pins against.
      expect(symbol).not.toContain(',');
      expect(limit).toBe(10);
    }
  });

  it('caps a 50-symbol union at exactly 50 requests', async () => {
    const symbols = Array.from({ length: 50 }, (_, i) => `CAP${String(i).padStart(2, '0')}`);
    queueFeedWalk(symbols);

    const feed = await loadNewsFeed(USER, 50);
    expect(feed.degraded).toBe(false);
    expect(h.getNewsArticles).toHaveBeenCalledTimes(50);
  });

  it('never has more than 5 requests unsettled at once (12 symbols)', async () => {
    const symbols = Array.from({ length: 12 }, (_, i) => `CB${i}`);
    queueFeedWalk(symbols);

    let inflight = 0;
    let maxInflight = 0;
    const pending: Array<() => void> = [];
    h.getNewsArticles.mockImplementation(() => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise((resolve) => {
        pending.push(() => {
          inflight -= 1;
          resolve([]);
        });
      });
    });

    const feedPromise = loadNewsFeed(USER, 50);
    let settled = 0;
    while (settled < symbols.length) {
      // Let the pool schedule, then release ONE deferred at a time — the
      // bound must hold at every instant, not just on average.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inflight).toBeLessThanOrEqual(5);
      const release = pending.shift();
      if (release === undefined) continue;
      release();
      settled += 1;
    }

    const feed = await feedPromise;
    expect(feed.degraded).toBe(false);
    expect(h.getNewsArticles).toHaveBeenCalledTimes(12);
    expect(maxInflight).toBe(5); // genuinely parallel, and never beyond
  });

  it('does not re-ask the vendor for the same symbol set within the TTL', async () => {
    queueFeedWalk(['TTL1', 'TTL2']);
    await loadNewsFeed(USER, 50);
    expect(h.getNewsArticles).toHaveBeenCalledTimes(2);

    queueFeedWalk(['TTL1', 'TTL2']);
    await loadNewsFeed(USER, 50);
    expect(h.getNewsArticles).toHaveBeenCalledTimes(2); // unchanged
  });
});

describe('loadNewsFeed — partial failure and the degraded flag', () => {
  it('1 of 6 failing stays below the ratio: not degraded, the 5 successes persisted', async () => {
    const symbols = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
    queueFeedWalk(symbols);
    h.getNewsArticles.mockImplementation((symbol: string) =>
      symbol === 'D3'
        ? Promise.reject(new Error('vendor 500'))
        : Promise.resolve([{ id: `art-${symbol}` }]),
    );

    const feed = await loadNewsFeed(USER, 50);
    expect(feed.degraded).toBe(false); // 1/6 ≈ 0.17, not > 0.2
    expect(h.persistArticles).toHaveBeenCalledTimes(1);
    const persisted = h.persistArticles.mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(persisted.map((a) => a.id).sort()).toEqual([
      'art-D1',
      'art-D2',
      'art-D4',
      'art-D5',
      'art-D6',
    ]);
  });

  it('2 of 5 failing crosses the ratio: degraded, the 3 successes still persisted', async () => {
    const symbols = ['E1', 'E2', 'E3', 'E4', 'E5'];
    queueFeedWalk(symbols);
    h.getNewsArticles.mockImplementation((symbol: string) =>
      symbol === 'E2' || symbol === 'E4'
        ? Promise.reject(new Error('vendor 500'))
        : Promise.resolve([{ id: `art-${symbol}` }]),
    );

    const feed = await loadNewsFeed(USER, 50);
    expect(feed.degraded).toBe(true); // 2/5 = 0.4 > 0.2
    const persisted = h.persistArticles.mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(persisted.map((a) => a.id).sort()).toEqual(['art-E1', 'art-E3', 'art-E5']);
  });

  it('a failed store write forces degraded even with every fetch green', async () => {
    queueFeedWalk(['WFAIL']);
    h.getNewsArticles.mockResolvedValue([{ id: 'w1' }]);
    h.persistArticles.mockResolvedValue(false);

    const feed = await loadNewsFeed(USER, 50);
    // Fetched stories that never reached the rows the feed reads from are as
    // absent as a failed fetch.
    expect(feed.degraded).toBe(true);
  });

  it('the same article arriving from two symbols is persisted exactly once', async () => {
    queueFeedWalk(['DUPA', 'DUPB']);
    h.getNewsArticles.mockResolvedValue([{ id: 'shared-1' }]);

    const feed = await loadNewsFeed(USER, 50);
    expect(feed.degraded).toBe(false);
    // Duplicate ids inside ONE insert statement reject the whole statement in
    // Postgres — cross-symbol overlap is the NORMAL case, so the dedupe is
    // load-bearing, not an optimization.
    expect(h.persistArticles).toHaveBeenCalledTimes(1);
    const persisted = h.persistArticles.mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(persisted.map((a) => a.id)).toEqual(['shared-1']);
  });
});

describe('loadTickerNews — single-symbol refresh keeps its semantics', () => {
  it('a 1-of-1 failure on the thin path reports degraded (1/1 > 0.2)', async () => {
    h.queue.push(
      { value: [{ symbol: 'THIN1' }] }, // watched — validates the candidate
      { value: [] }, // transactions
      { value: [] }, // option underlyings
      { value: [] }, // stored rows — thin, triggers the refresh
      { value: [] }, // re-read after the refresh
    );
    h.getNewsArticles.mockRejectedValue(new Error('vendor down'));

    const news = await loadTickerNews(USER, 'THIN1', 5);
    expect(news).toEqual({ articles: [], degraded: true });
    expect(h.getNewsArticles).toHaveBeenCalledTimes(1);
    expect(h.getNewsArticles).toHaveBeenCalledWith('THIN1', 10);
  });
});
