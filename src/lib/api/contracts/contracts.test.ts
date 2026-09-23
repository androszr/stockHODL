import { describe, expect, it } from 'vitest';

import { emptySeries, type ChartPoint } from '@/lib/charts/series';
import { composeWatchlistPayload } from '@/lib/watchlist/watchlist-payload';

import {
  fxRateQuerySchema,
  fxRateResponseSchema,
  portfolioReorderSchema,
  portfolioSeriesQuerySchema,
  seriesPayloadSchema,
  symbolParamSchema,
  symbolSearchQuerySchema,
  symbolSearchResponseSchema,
  transactionCreateSchema,
  transactionListQuerySchema,
  transactionRowSchema,
  watchlistAddRequestSchema,
  watchlistPayloadSchema,
} from './index';

/**
 * The contracts, exercised the way the handlers exercise them.
 *
 * The point is not that zod works. It is that these schemas describe the
 * SHAPES THIS APP ACTUALLY PRODUCES AND ACCEPTS — the money discipline
 * (strings, never numbers), the input rules inherited from
 * `src/lib/validation.ts`, and the real `SeriesPayload` output.
 */

describe('money never crosses the wire as a number', () => {
  it('rejects a numeric amount on a transaction row', () => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111',
      portfolioId: '22222222-2222-4222-8222-222222222222',
      portfolioName: 'Main',
      instrumentId: '33333333-3333-4333-8333-333333333333',
      symbol: 'AAPL',
      displayName: 'Apple Inc.',
      exchange: 'NASDAQ',
      currency: 'USD',
      side: 'buy' as const,
      quantity: '10.00000000',
      price: '100.00000000',
      fees: '0.00000000',
      tradeDate: '2026-01-05',
      fxRateToBase: '4.0000000000',
      note: null,
    };

    expect(transactionRowSchema.safeParse(row).success).toBe(true);
    // The float that must never appear: a price parsed on its way out.
    expect(transactionRowSchema.safeParse({ ...row, price: 100 }).success).toBe(false);
    expect(transactionRowSchema.safeParse({ ...row, quantity: 10 }).success).toBe(false);
  });
});

describe('transaction write contract is the web form contract', () => {
  const base = {
    portfolioId: '22222222-2222-4222-8222-222222222222',
    side: 'buy',
    symbol: 'aapl',
    displayName: 'Apple Inc.',
    exchange: 'NASDAQ',
    currency: 'USD',
    quantity: '10',
    price: '100',
    fees: '',
    tradeDate: '2026-01-05',
    fxRateToBase: '4,05',
    note: '',
  };

  it('normalizes the pl-PL comma separator, as the form does', () => {
    const parsed = transactionCreateSchema.safeParse(base);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.fxRateToBase).toBe('4.05');
      // Empty fees default to '0', never to a missing column.
      expect(parsed.data.fees).toBe('0');
      // Symbols are uppercased once, at the boundary.
      expect(parsed.data.symbol).toBe('AAPL');
    }
  });

  it('refuses an ambiguous thousands separator rather than guessing', () => {
    // '1,250' would silently become 1.25 — a 1000x error. The web refuses it;
    // so must the phone, and for free, because it is the same schema.
    const parsed = transactionCreateSchema.safeParse({ ...base, quantity: '1,250' });
    expect(parsed.success).toBe(false);
  });

  it('requires an FX rate for a non-PLN instrument and forces 1 for PLN', () => {
    expect(
      transactionCreateSchema.safeParse({ ...base, fxRateToBase: '' }).success,
    ).toBe(false);

    const pln = transactionCreateSchema.safeParse({
      ...base,
      currency: 'PLN',
      fxRateToBase: '999',
    });
    expect(pln.success).toBe(true);
    // Whatever the client sent is ignored: PLN is the base currency.
    if (pln.success) expect(pln.data.fxRateToBase).toBe('1');
  });

  it('rejects a date that does not exist on the calendar', () => {
    expect(
      transactionCreateSchema.safeParse({ ...base, tradeDate: '2026-02-31' }).success,
    ).toBe(false);
  });
});

describe('query contracts', () => {
  it('narrows the transaction list by portfolio or symbol, or not at all', () => {
    expect(transactionListQuerySchema.parse({})).toEqual({});
    expect(transactionListQuerySchema.parse({ symbol: 'aapl' }).symbol).toBe('AAPL');
    expect(transactionListQuerySchema.safeParse({ portfolioId: 'nope' }).success).toBe(false);
  });

  it('accepts only the eight chart ranges', () => {
    expect(portfolioSeriesQuerySchema.safeParse({ range: '1D' }).success).toBe(true);
    expect(portfolioSeriesQuerySchema.safeParse({ range: '3D' }).success).toBe(false);
  });

  it('takes a portfolio scope as an opaque string, not a uuid', () => {
    // Deliberate: a malformed scope must degrade to the all-portfolios
    // series through `resolvePortfolioScope`, not 400. Validating it here
    // would turn a stale deep link into an error the web never shows.
    expect(
      portfolioSeriesQuerySchema.safeParse({ range: '1D', portfolioId: 'garbage' }).success,
    ).toBe(true);
  });

  it('bounds a symbol path parameter the same way a symbol input is bounded', () => {
    expect(symbolParamSchema.parse(' aapl ')).toBe('AAPL');
    expect(symbolParamSchema.safeParse('A'.repeat(21)).success).toBe(false);
    expect(symbolParamSchema.safeParse('').success).toBe(false);
  });

  it('refuses a PLN FX lookup outright', () => {
    expect(
      fxRateQuerySchema.safeParse({ currency: 'USD', tradeDate: '2026-01-05' }).success,
    ).toBe(true);
    // The client short-circuits to '1'; asking NBP for PLN/PLN is a bug.
    expect(
      fxRateQuerySchema.safeParse({ currency: 'PLN', tradeDate: '2026-01-05' }).success,
    ).toBe(false);
  });

  it('rejects a reorder list that is empty or absurdly long', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(portfolioReorderSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(portfolioReorderSchema.safeParse({ ids: [id] }).success).toBe(true);
    expect(
      portfolioReorderSchema.safeParse({ ids: Array(501).fill(id) }).success,
    ).toBe(false);
  });
});

describe('watchlist add reuses the transaction instrument rules', () => {
  it('uppercases the symbol and holds the closed currency list', () => {
    const parsed = watchlistAddRequestSchema.safeParse({
      symbol: 'msft',
      displayName: 'Microsoft',
      exchange: 'NASDAQ',
      currency: 'USD',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.symbol).toBe('MSFT');

    expect(
      watchlistAddRequestSchema.safeParse({
        symbol: 'MSFT',
        displayName: 'Microsoft',
        exchange: 'NASDAQ',
        currency: 'JPY',
      }).success,
    ).toBe(false);
  });
});

describe('series contract describes the real SeriesPayload', () => {
  it('accepts the empty payload', () => {
    expect(seriesPayloadSchema.safeParse(emptySeries()).success).toBe(true);
  });

  it('accepts a built series and keeps values as strings', () => {
    const points: ChartPoint[] = [{ t: 1_754_800_000_000, v: '110.25' }];
    const payload = {
      points,
      partialDays: 0,
      excludedSymbols: [],
      anchorDate: '2026-01-05',
    };
    const parsed = seriesPayloadSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(typeof payload.points[0].v).toBe('string');
  });

  it('rejects a point whose value arrived as a float', () => {
    const parsed = seriesPayloadSchema.safeParse({
      points: [{ t: 1_754_800_000_000, v: 110.25 }],
      partialDays: 0,
      excludedSymbols: [],
      anchorDate: null,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an options payload WITH the estimatedFrom seam', () => {
    // The options series is the only builder that sets it; the phone decodes
    // it as an optional, so both shapes must parse.
    const parsed = seriesPayloadSchema.safeParse({
      points: [{ t: 1_754_800_000_000, v: '9.99' }],
      partialDays: 0,
      excludedSymbols: [],
      anchorDate: '2026-05-20',
      estimatedFrom: '2026-08-17',
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('accepts the same payload WITHOUT it — every other series', () => {
    const parsed = seriesPayloadSchema.safeParse({
      points: [{ t: 1_754_800_000_000, v: '9.99' }],
      partialDays: 0,
      excludedSymbols: [],
      anchorDate: '2026-05-20',
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.success && 'estimatedFrom' in parsed.data).toBe(false);
  });

  it('rejects an estimatedFrom that is not a calendar date', () => {
    const parsed = seriesPayloadSchema.safeParse({
      points: [],
      partialDays: 0,
      excludedSymbols: [],
      anchorDate: null,
      estimatedFrom: '17 sie 2026',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('fx response is a discriminated union the client can switch on', () => {
  it('accepts both arms and rejects a mixed one', () => {
    expect(
      fxRateResponseSchema.safeParse({ ok: true, rate: '4.05', rateDate: '2026-01-02' })
        .success,
    ).toBe(true);
    expect(
      fxRateResponseSchema.safeParse({ ok: false, reason: 'not_published' }).success,
    ).toBe(true);
    // A success without a rate would decode into a Swift struct with a
    // missing amount — the exact drift the contract exists to stop.
    expect(fxRateResponseSchema.safeParse({ ok: true, rate: '4.05' }).success).toBe(false);
    expect(fxRateResponseSchema.safeParse({ ok: false, reason: 'whoops' }).success).toBe(
      false,
    );
  });
});

describe('symbol search contract', () => {
  it('accepts what the search actually returns, degraded flag and all', () => {
    const match = {
      symbol: 'BRK.A',
      name: 'Berkshire Hathaway Inc.',
      exchange: 'NYSE',
      exchangeDisplay: 'NYSE',
      type: 'equity' as const,
      currency: 'USD' as const,
    };

    expect(symbolSearchResponseSchema.safeParse({ results: [match] }).success).toBe(true);
    // The provider failed AND the directory had nothing — the only case that
    // earns the flag, because it tells the user to type the ticker in by hand.
    expect(
      symbolSearchResponseSchema.safeParse({ results: [], degraded: true }).success,
    ).toBe(true);
    // `degraded: false` is not a state this API has. Absent means fine.
    expect(
      symbolSearchResponseSchema.safeParse({ results: [], degraded: false }).success,
    ).toBe(false);
  });

  it('leaves currency absent rather than guessing one', () => {
    // `symbol-search.ts` stamps a currency only when the exchange is
    // confidently mapped. Defaulting to USD here would mint an instrument in
    // the wrong currency — permanently, since `instruments` is global and
    // first-write-wins.
    const unmapped = {
      symbol: 'XYZ',
      name: 'Somewhere Ltd',
      exchange: 'XLON',
      exchangeDisplay: 'LSE',
      type: 'equity' as const,
    };
    const parsed = symbolSearchResponseSchema.parse({ results: [unmapped] });
    expect(parsed.results[0].currency).toBeUndefined();
  });

  it('bounds the query the same way the web route does', () => {
    expect(symbolSearchQuerySchema.safeParse({ q: '  aapl ' }).data?.q).toBe('aapl');
    expect(symbolSearchQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(symbolSearchQuerySchema.safeParse({ q: 'x'.repeat(41) }).success).toBe(false);
  });
});

describe('watchlist payload contract describes what the composer emits', () => {
  it('accepts a real composition, quotes and all', () => {
    const payload = composeWatchlistPayload(
      [{ instrumentId: '44444444-4444-4444-8444-444444444444', symbol: 'AAPL', currency: 'USD' }],
      {
        market: {
          status: 'open',
          nextTransitionAtMs: null,
          nextTransitionKind: null,
          pollingResumesAtMs: null,
        },
        hasPollableSymbols: true,
        targetsByInstrument: new Map(),
      },
      new Map(),
    );

    expect(watchlistPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('carries no quote as null, never as a fabricated zero', () => {
    const payload = composeWatchlistPayload(
      [{ instrumentId: '44444444-4444-4444-8444-444444444444', symbol: 'ZZZZ', currency: 'USD' }],
      {
        market: {
          status: 'closed',
          nextTransitionAtMs: null,
          nextTransitionKind: null,
          pollingResumesAtMs: null,
        },
        hasPollableSymbols: false,
        targetsByInstrument: new Map(),
      },
      new Map(),
    );

    const parsed = watchlistPayloadSchema.parse(payload);
    // A zero price would render as a real quote of 0,00 — the tile must say
    // "—" instead, and that starts with the payload refusing to invent one.
    expect(parsed.items[0].price).toBeNull();
    expect(parsed.items[0].dayPct).toBeNull();
  });
});
