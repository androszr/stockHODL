import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MarketSessionInfo, Quote, QuoteOutcome } from '@/lib/market-data/provider';

/**
 * The narrowing-equivalence suite (hard condition 1 of the 2026-08-16
 * ticker-page plan): the ticker page swapping `loadHoldingsInputs(userId)`
 * for `loadInstrumentInputs(rows)` must not change a single figure on that
 * page. The before/after pin below runs BOTH loaders — real implementations,
 * boundaries mocked (the live-view.test.ts pattern) — over the same
 * 3-instrument, 2-currency fixture and asserts the target instrument's
 * composed view and raw quote/FX lookups are identical.
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
  persistThrottleKey: (ids: Iterable<string>) => [...new Set(ids)].sort().join('\n'),
}));

import { loadInstrumentInputs } from './instrument-view';
import {
  composeHoldingsView,
  loadHoldingsInputs,
  type HoldingsSourceRow,
} from './live-view';

/* ------------------------------------------------------------------ *
 * Fixture: three instruments, two non-PLN currencies plus PLN — AAPL
 * (USD, the target), SAP (EUR) and CDR (PLN, which must never reach NBP).
 * ------------------------------------------------------------------ */

function quote(symbol: string, price: string): Quote {
  return {
    symbol,
    price,
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

const QUOTE_PRICES: Record<string, string> = { AAPL: '231.59', SAP: '212.40', CDR: '145.10' };
const FX_RATES: Record<string, string> = { USD: '3.65', EUR: '4.27' };

function txRow(over: {
  id: string;
  instrumentId: string;
  symbol: string;
  currency: string;
  side?: 'buy' | 'sell';
  quantity?: string;
}): HoldingsSourceRow {
  return {
    id: over.id,
    instrumentId: over.instrumentId,
    symbol: over.symbol,
    displayName: `${over.symbol} Inc.`,
    currency: over.currency,
    side: over.side ?? 'buy',
    quantity: over.quantity ?? '10',
    price: '190',
    fees: '1',
    fxRateToBase: '4.05',
    tradeDate: '2026-08-10',
    createdAt: new Date('2026-08-10T14:00:00Z'),
    portfolioId: 'p1',
    portfolioName: 'Main',
  };
}

const ALL_ROWS: HoldingsSourceRow[] = [
  txRow({ id: 'tx-1', instrumentId: 'i-aapl', symbol: 'AAPL', currency: 'USD' }),
  txRow({ id: 'tx-2', instrumentId: 'i-aapl', symbol: 'AAPL', currency: 'USD', quantity: '5' }),
  txRow({ id: 'tx-3', instrumentId: 'i-sap', symbol: 'SAP', currency: 'EUR' }),
  txRow({ id: 'tx-4', instrumentId: 'i-cdr', symbol: 'CDR', currency: 'PLN' }),
];
const TARGET_ROWS = ALL_ROWS.filter((r) => r.symbol === 'AAPL');
const PORTFOLIO_ROWS = [{ id: 'p1', name: 'Main' }];

/** Chainable, thenable drizzle-select stand-in (live-view.test.ts pattern). */
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

function marketInfo(): MarketSessionInfo {
  return {
    status: 'open',
    nextTransitionAtMs: 1_755_288_000_000,
    nextTransitionKind: 'close',
    pollingResumesAtMs: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.persistQuotes.mockResolvedValue(undefined);
  h.readCachedQuotes.mockResolvedValue(new Map());
  // Deterministic per-symbol answers — the SAME quote for a symbol no matter
  // which loader (or how narrow a batch) asks for it.
  h.getQuotes.mockImplementation(async (symbols: readonly string[]) => {
    const outcomes = new Map<string, QuoteOutcome>();
    for (const symbol of symbols) {
      const price = QUOTE_PRICES[symbol];
      if (price !== undefined) outcomes.set(symbol, { ok: true, quote: quote(symbol, price) });
    }
    return outcomes;
  });
  h.getCurrentFxRateToPln.mockImplementation(async (currency: string) => {
    const rate = FX_RATES[currency];
    return rate !== undefined ? { ok: true, rate } : { ok: false, reason: 'no_rate' };
  });
  h.getMarketStatus.mockResolvedValue(marketInfo());
  // loadHoldingsInputs' two queries, in construction order.
  h.dbSelect
    .mockImplementationOnce(() => selectChain(PORTFOLIO_ROWS))
    .mockImplementationOnce(() => selectChain(ALL_ROWS));
});

describe('loadInstrumentInputs ≡ loadHoldingsInputs for the instrument (the before/after pin)', () => {
  it('composes the identical StaticHolding, LiveHolding and quote/FX inputs for the target', async () => {
    const fullView = composeHoldingsView(await loadHoldingsInputs('user-1'));
    const narrowLoaded = await loadInstrumentInputs(TARGET_ROWS);
    const narrowView = composeHoldingsView(narrowLoaded);

    // The header + position figures the page reads (`staticHoldings` /
    // `live.holdings` filtered to THIS instrumentId) — deep-equal.
    const fullStatic = fullView.staticHoldings.find((s) => s.instrumentId === 'i-aapl');
    const narrowStatic = narrowView.staticHoldings.find((s) => s.instrumentId === 'i-aapl');
    expect(narrowStatic).toBeDefined();
    expect(narrowStatic).toEqual(fullStatic);

    const fullLive = fullView.live.holdings.find((l) => l.instrumentId === 'i-aapl');
    const narrowLive = narrowView.live.holdings.find((l) => l.instrumentId === 'i-aapl');
    expect(narrowLive).toBeDefined();
    expect(narrowLive).toEqual(fullLive);

    // The raw maps `DayStats` and `computePortfolioGroups` price with —
    // identical for THIS symbol and THIS currency.
    const fullLoaded = await (async () => {
      // Re-run the full walk for the raw maps (fresh db mocks for the pair).
      h.dbSelect
        .mockImplementationOnce(() => selectChain(PORTFOLIO_ROWS))
        .mockImplementationOnce(() => selectChain(ALL_ROWS));
      return loadHoldingsInputs('user-1');
    })();
    expect(narrowLoaded.quotes.get('AAPL')).toEqual(fullLoaded.quotes.get('AAPL'));
    expect(narrowLoaded.inputs.fxRates.get('USD')).toBe(fullLoaded.inputs.fxRates.get('USD'));
    expect(narrowLoaded.inputs.market).toEqual(fullLoaded.inputs.market);
  });
});

describe('loadInstrumentInputs — vendor discipline', () => {
  it('asks the vendor for exactly the one symbol, with its cache ref', async () => {
    await loadInstrumentInputs(TARGET_ROWS);
    expect(h.getQuotes).toHaveBeenCalledTimes(1);
    expect(h.getQuotes).toHaveBeenCalledWith(['AAPL']);
    // The single-symbol refs map keeps the durable-cache write scoped to the
    // user's own instrument row.
    expect(h.persistQuotes).toHaveBeenCalledWith(
      [expect.objectContaining({ instrumentId: 'i-aapl' })],
      'i-aapl',
    );
  });

  it('asks NBP for exactly the one non-PLN currency — never PLN, never the others', async () => {
    await loadInstrumentInputs(TARGET_ROWS);
    expect(h.getCurrentFxRateToPln).toHaveBeenCalledTimes(1);
    expect(h.getCurrentFxRateToPln).toHaveBeenCalledWith('USD');

    h.getCurrentFxRateToPln.mockClear();
    await loadInstrumentInputs(ALL_ROWS.filter((r) => r.symbol === 'CDR'));
    expect(h.getCurrentFxRateToPln).not.toHaveBeenCalled();
  });
});

describe('loadInstrumentInputs — degradation', () => {
  it('all three legs failing still RESOLVES with empty maps and a clock-derived status', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.getQuotes.mockRejectedValue(new Error('vendor down'));
    h.getCurrentFxRateToPln.mockRejectedValue(new Error('nbp down'));
    h.getMarketStatus.mockRejectedValue(new Error('status down'));

    const loaded = await loadInstrumentInputs(TARGET_ROWS);

    expect(loaded.quotes.size).toBe(0);
    expect(loaded.inputs.fxRates.size).toBe(0);
    // Clock-derived fallback — a real status word, never a throw.
    expect(typeof loaded.inputs.market.status).toBe('string');
    expect(loaded.rows).toHaveLength(2);
    consoleError.mockRestore();
  });
});

describe('loadInstrumentInputs — no scopes', () => {
  it('omits `portfolios`, so the composed view carries zero scopes', async () => {
    const loaded = await loadInstrumentInputs(TARGET_ROWS);
    expect(loaded.inputs.portfolios).toBeUndefined();
    expect(composeHoldingsView(loaded).scopes).toEqual([]);
  });

  it('documents hasPollableSymbols as present (shape parity) though unconsumed by the page', async () => {
    const loaded = await loadInstrumentInputs(TARGET_ROWS);
    expect(typeof loaded.inputs.hasPollableSymbols).toBe('boolean');
  });
});
