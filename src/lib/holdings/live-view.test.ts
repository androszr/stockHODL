import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MarketSessionInfo, Quote, QuoteOutcome } from '@/lib/market-data/provider';

/**
 * `fetchQuotesBestEffort`'s cache-persistence contract — specifically the
 * 2026-08-16 gap fix: the persist is AWAITED, never a floating promise. On
 * Vercel a fire-and-forget write inside an RSC render or route handler can
 * be frozen with the instance once the response is sent — dropping exactly
 * the cold-start write the cache exists for. Boundaries mocked (the
 * massive.test.ts pattern); the function under test is real.
 */

const h = vi.hoisted(() => ({
  getQuotes: vi.fn(),
  getMarketStatus: vi.fn(),
  getCurrentFxRateToPln: vi.fn(),
  persistQuotes: vi.fn(),
  readCachedQuotes: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  db: { select: h.dbSelect },
  instruments: {},
  portfolios: {},
  transactions: {},
}));
vi.mock('@/lib/fx/nbp', () => ({ getCurrentFxRateToPln: h.getCurrentFxRateToPln }));

vi.mock('@/lib/market-data/massive', () => ({
  massiveProvider: { getQuotes: h.getQuotes, getMarketStatus: h.getMarketStatus },
}));
vi.mock('@/lib/market-data/quote-cache', () => ({
  persistQuotes: h.persistQuotes,
  readCachedQuotes: h.readCachedQuotes,
  // The real pure key builder — the caller must pass the REQUESTED id set.
  persistThrottleKey: (ids: Iterable<string>) => [...new Set(ids)].sort().join('\n'),
}));

import { fetchQuotesBestEffort, loadHoldingsInputs } from './live-view';

function quote(): Quote {
  return {
    symbol: 'AAPL',
    price: '231.59',
    prevClose: '229.35',
    asOf: new Date('2026-08-14T20:00:00Z'),
    asOfSource: 'trade',
    delaySeconds: 900,
    marketStatus: 'closed',
    dayChangeAmt: '2.24',
    dayChangePct: '0.98',
    dayOpen: '229.9',
    dayHigh: '232.5',
    dayLow: '229.1',
    dayVolume: 51234567,
    vwap: '231.02',
    extendedChangeAmt: null,
    extendedChangePct: null,
    extendedKind: null,
    extendedEndedAtMs: null,
    extendedLive: false,
    source: 'massive',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.persistQuotes.mockResolvedValue(undefined);
  h.readCachedQuotes.mockResolvedValue(new Map());
});

describe('fetchQuotesBestEffort — the persist is awaited, not floating', () => {
  it('completes the cache write BEFORE returning — the regression: a void-ed promise dies with a frozen serverless instance', async () => {
    const outcomes = new Map<string, QuoteOutcome>([['AAPL', { ok: true, quote: quote() }]]);
    h.getQuotes.mockResolvedValue(outcomes);

    let persisted = false;
    h.persistQuotes.mockImplementation(async () => {
      // Resolve strictly after the current microtask — a floating `void`
      // call would let fetchQuotesBestEffort return with this still false.
      await new Promise((resolve) => setTimeout(resolve, 0));
      persisted = true;
    });

    await fetchQuotesBestEffort(['AAPL'], new Map([['AAPL', 'i1']]));

    expect(h.persistQuotes).toHaveBeenCalledWith(
      [{ instrumentId: 'i1', quote: quote() }],
      // Keyed off the requested refs, not the answered subset.
      'i1',
    );
    expect(persisted).toBe(true);
  });

  it('without refs, nothing is persisted and nothing is read back', async () => {
    h.getQuotes.mockResolvedValue(
      new Map<string, QuoteOutcome>([['AAPL', { ok: true, quote: quote() }]]),
    );

    const { quotes, cached } = await fetchQuotesBestEffort(['AAPL']);

    expect(quotes.has('AAPL')).toBe(true);
    expect(cached.size).toBe(0);
    expect(h.persistQuotes).not.toHaveBeenCalled();
    expect(h.readCachedQuotes).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * loadHoldingsInputs — the parallel walk (2026-08-16 live-render plan).
 * The two DB queries run together, then quotes / FX / market status run
 * together — but only AFTER the transaction rows resolved, because the
 * symbol and currency sets derive from those rows. Each leg is never-throw
 * best-effort, which is what makes the Promise.all safe: the degradation
 * test below is the enforcement of that contract.
 * ------------------------------------------------------------------ */

/** One joined transaction row, as the drizzle select would return it. */
function txRow(overrides: { symbol?: string; instrumentId?: string; currency?: string } = {}) {
  return {
    id: 'tx-1',
    instrumentId: overrides.instrumentId ?? 'i1',
    symbol: overrides.symbol ?? 'AAPL',
    displayName: 'Apple Inc.',
    currency: overrides.currency ?? 'USD',
    side: 'buy',
    quantity: '10',
    price: '190',
    fees: '0',
    fxRateToBase: '4.05',
    tradeDate: '2026-08-10',
    createdAt: new Date('2026-08-10T14:00:00Z'),
    portfolioId: 'p1',
    portfolioName: 'Main',
  };
}

const PORTFOLIO_ROWS = [{ id: 'p1', name: 'Main' }];

/**
 * A chainable, thenable stand-in for one drizzle select builder: every
 * builder method returns the same object, and awaiting it resolves the given
 * rows. `loadHoldingsInputs` builds the portfolios query first, then the
 * transactions join — mockImplementationOnce order matches.
 */
function selectChain(rows: unknown[]) {
  const builder = {
    from: () => builder,
    where: () => builder,
    innerJoin: () => builder,
    orderBy: () => builder,
    then: (
      onFulfilled?: (value: unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
  return builder;
}

function mockDb(portfolioRows: unknown[], transactionRows: unknown[]) {
  h.dbSelect
    .mockImplementationOnce(() => selectChain(portfolioRows))
    .mockImplementationOnce(() => selectChain(transactionRows));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued macrotasks (and every microtask behind them) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function marketInfo(): MarketSessionInfo {
  return {
    status: 'open',
    nextTransitionAtMs: 1_755_288_000_000,
    nextTransitionKind: 'close',
    pollingResumesAtMs: null,
  };
}

describe('loadHoldingsInputs — parallel walk', () => {
  it('starts quotes, FX and market status concurrently, and returns the sequential-era shape', async () => {
    mockDb(PORTFOLIO_ROWS, [txRow()]);
    const quotesDeferred = deferred<Map<string, QuoteOutcome>>();
    const fxDeferred = deferred<{ ok: true; rate: string }>();
    const statusDeferred = deferred<MarketSessionInfo>();
    h.getQuotes.mockReturnValue(quotesDeferred.promise);
    h.getCurrentFxRateToPln.mockReturnValue(fxDeferred.promise);
    h.getMarketStatus.mockReturnValue(statusDeferred.promise);

    const loading = loadHoldingsInputs('user-1');
    await flush();

    // The concurrency fact: all three legs are IN FLIGHT before any of them
    // resolved — the sequential era would not have called FX or status yet.
    expect(h.getQuotes).toHaveBeenCalledWith(['AAPL']);
    expect(h.getCurrentFxRateToPln).toHaveBeenCalledWith('USD');
    expect(h.getMarketStatus).toHaveBeenCalledTimes(1);

    quotesDeferred.resolve(new Map<string, QuoteOutcome>([['AAPL', { ok: true, quote: quote() }]]));
    fxDeferred.resolve({ ok: true, rate: '3.65' });
    statusDeferred.resolve(marketInfo());
    const loaded = await loading;

    // Exactly what the one-after-another version returned.
    expect(loaded.rows).toHaveLength(1);
    expect(loaded.rows[0].side).toBe('buy');
    expect(loaded.quotes.get('AAPL')?.price).toBe('231.59');
    expect(loaded.inputs.fxRates).toEqual(new Map([['USD', '3.65']]));
    expect(loaded.inputs.market).toEqual(marketInfo());
    expect(loaded.inputs.hasPollableSymbols).toBe(true);
    expect(loaded.inputs.portfolios).toEqual(PORTFOLIO_ROWS);
    expect(loaded.inputs.cachedQuotes?.size).toBe(0);
  });

  it('asks NBP once per distinct non-PLN currency from the rows, and never for PLN', async () => {
    mockDb(PORTFOLIO_ROWS, [
      txRow({ symbol: 'AAPL', instrumentId: 'i1', currency: 'USD' }),
      txRow({ symbol: 'MSFT', instrumentId: 'i2', currency: 'USD' }),
      txRow({ symbol: 'SAP', instrumentId: 'i3', currency: 'EUR' }),
      txRow({ symbol: 'CDR', instrumentId: 'i4', currency: 'PLN' }),
    ]);
    h.getQuotes.mockResolvedValue(new Map());
    h.getCurrentFxRateToPln.mockResolvedValue({ ok: true, rate: '4.00' });
    h.getMarketStatus.mockResolvedValue(marketInfo());

    await loadHoldingsInputs('user-1');

    // The FX currency set DERIVES from the awaited transaction rows — the
    // dependency the parallelization must preserve (hard condition 2).
    expect(h.getCurrentFxRateToPln).toHaveBeenCalledTimes(2);
    expect(h.getCurrentFxRateToPln).toHaveBeenCalledWith('USD');
    expect(h.getCurrentFxRateToPln).toHaveBeenCalledWith('EUR');
    expect(h.getCurrentFxRateToPln).not.toHaveBeenCalledWith('PLN');
  });

  it('all three legs failing still RESOLVES, degraded — the Promise.all never rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDb(PORTFOLIO_ROWS, [txRow()]);
    h.getQuotes.mockRejectedValue(new Error('vendor down'));
    h.getCurrentFxRateToPln.mockRejectedValue(new Error('nbp down'));
    h.getMarketStatus.mockRejectedValue(new Error('status down'));

    const loaded = await loadHoldingsInputs('user-1');

    expect(loaded.quotes.size).toBe(0);
    expect(loaded.inputs.fxRates.size).toBe(0);
    // Clock-derived fallback — a real status word, never a throw.
    expect(typeof loaded.inputs.market.status).toBe('string');
    expect(loaded.rows).toHaveLength(1);
    expect(loaded.inputs.portfolios).toEqual(PORTFOLIO_ROWS);
    consoleError.mockRestore();
  });
});
