import { describe, expect, it } from 'vitest';

import type { ChartPoint } from '@/lib/charts/series';
import type { HoldingQuote } from '@/lib/holdings/live-payload';

/**
 * The composer's two load-bearing rules — the exclusion filter and the scope
 * agreement — over INJECTED inputs. The framework boundaries are stubbed only
 * so the `server-only` module can be imported at all (the
 * `price-history.test.ts` arrangement); nothing here touches a DB or a vendor.
 */
import { vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: {}, instruments: {}, portfolios: {}, portfolioTargets: {} }));
vi.mock('@/lib/fx/nbp', () => ({ getFxRatesForRange: async () => new Map() }));
vi.mock('@/lib/history/price-history', () => ({ getDailyCloses: async () => new Map() }));
vi.mock('@/lib/history/portfolio-series', () => ({
  buildDailyPortfolioSeries: () => ({
    points: [],
    partialDays: 0,
    partialDates: [],
    excludedSymbols: [],
  }),
  loadDailyClosesByInstrument: async () => new Map(),
}));
vi.mock('@/lib/holdings/live-view', () => ({ loadHoldingsInputs: async () => ({}) }));
vi.mock('@/lib/holdings/scope', () => ({ resolvePortfolioScope: async () => null }));
vi.mock('@/lib/instruments/profile', () => ({ syncInstrumentProfiles: async () => {} }));
vi.mock('@/lib/instruments/resolve', () => ({ resolveOrCreateInstrument: async () => ({ ok: false }) }));
vi.mock('@/lib/market-data/market-clock', () => ({ nyDateISOAt: () => '2026-08-18' }));

import { analyticsResponseSchema } from '@/lib/api/contracts/analytics';
import { dec, fmtMoney } from '@/lib/money';

import {
  composeAnalyticsView,
  getAnalyticsView,
  resolveExclusions,
  runEnginePerPortfolio,
  type AnalyticsComposeInputs,
  type AnalyticsTransaction,
} from './view';

let seq = 0;
function tx(over: Partial<AnalyticsTransaction>): AnalyticsTransaction {
  seq += 1;
  return {
    id: `t${seq}`,
    instrumentId: 'i-aapl',
    symbol: 'AAPL',
    displayName: 'Apple',
    currency: 'USD',
    side: 'buy',
    quantity: '10',
    price: '100',
    fees: '0',
    fxRateToBase: '4',
    tradeDate: '2024-01-02',
    createdAt: new Date('2024-01-02T00:00:00Z'),
    portfolioId: 'p1',
    portfolioName: 'Main',
    ...over,
  };
}

const quote = (price: string, currency = 'USD'): HoldingQuote => ({
  price,
  currency,
  prevClose: null,
  dayChangeAmt: null,
  dayChangePct: null,
  extendedChangePct: null,
  extendedKind: null,
  extendedEndedAtMs: null,
  extendedLive: false,
});

const point = (dateISO: string, v: string): ChartPoint => ({
  t: Date.parse(`${dateISO}T00:00:00Z`),
  v,
});

function inputs(over: Partial<AnalyticsComposeInputs> = {}): AnalyticsComposeInputs {
  return {
    scopeId: null,
    scopes: [],
    engineTxs: [],
    quotes: new Map(),
    fxRates: new Map([['USD', '4']]),
    seriesPoints: [],
    seriesExcludedSymbols: [],
    partialDays: 0,
    partialDates: [],
    spyCloses: new Map(),
    usdPlnByDay: new Map(),
    profiles: new Map(),
    todayISO: '2026-08-18',
    ...over,
  };
}

describe('composeAnalyticsView — exclusion', () => {
  it('keeps an unpriceable OPEN position out of the return figures', () => {
    // The whole defence: this holding's buys would otherwise enter XIRR with
    // no terminal value and report a catastrophic loss on a position that is
    // merely unpriced.
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [
          tx({ instrumentId: 'i-aapl', symbol: 'AAPL', tradeDate: '2024-01-02' }),
          tx({
            instrumentId: 'i-cdr',
            symbol: 'CDR.WA',
            currency: 'PLN',
            fxRateToBase: '1',
            tradeDate: '2024-01-02',
          }),
        ],
        // Only AAPL is priced; CDR.WA is open and unpriceable.
        quotes: new Map([['AAPL', quote('200')]]),
      }),
    );

    expect(view.excludedSymbols).toEqual([{ symbol: 'CDR.WA', reason: 'no_live_quote' }]);
    // AAPL alone: -4000 in, 8000 out at today — a real, positive rate.
    expect(view.xirr.note).toBeNull();
    expect(view.xirr.direction).toBe('gain');
    // …and the unpriced ticker contributes to no slice, in any dimension.
    for (const slices of Object.values(view.breakdown)) {
      expect(slices.some((s) => s.label === 'CDR.WA')).toBe(false);
    }
  });

  it('keeps a CLOSED position in, priced or not', () => {
    // "Open AND unpriceable" is the predicate. A fully sold holding needs no
    // price: its flows are complete on both sides.
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [
          tx({
            instrumentId: 'i-cdr',
            symbol: 'CDR.WA',
            currency: 'PLN',
            fxRateToBase: '1',
            tradeDate: '2024-01-02',
          }),
          tx({
            instrumentId: 'i-cdr',
            symbol: 'CDR.WA',
            currency: 'PLN',
            fxRateToBase: '1',
            side: 'sell',
            price: '150',
            tradeDate: '2025-01-02',
          }),
        ],
        quotes: new Map(),
      }),
    );

    expect(view.excludedSymbols).toEqual([]);
    expect(view.inceptionDateISO).toBe('2024-01-02');
    // Bought for 1000, sold for 1500 a year later — a solvable, positive rate.
    expect(view.xirr.note).toBeNull();
    expect(view.xirr.direction).toBe('gain');
  });

  it('adds no terminal flow when nothing could be priced', () => {
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [tx({ instrumentId: 'i-cdr', symbol: 'CDR.WA', currency: 'PLN', fxRateToBase: '1' })],
        quotes: new Map(),
      }),
    );
    // Every transaction was filtered out by the exclusion rule, so the
    // refusal names THAT rather than claiming the scope is empty.
    expect(view.xirr.value).toBe('—');
    expect(view.xirr.note).toBe('Every holding in this scope is unpriced.');
  });
});

describe('composeAnalyticsView — scope agreement', () => {
  const twoPortfolios: AnalyticsTransaction[] = [
    tx({ portfolioId: 'p1', portfolioName: 'Main', instrumentId: 'i-aapl', symbol: 'AAPL' }),
    tx({
      portfolioId: 'p2',
      portfolioName: 'IKE',
      instrumentId: 'i-msft',
      symbol: 'MSFT',
      quantity: '5',
      price: '200',
    }),
  ];
  const prices = new Map([
    ['AAPL', quote('100')],
    ['MSFT', quote('200')],
  ]);

  it('sums the per-portfolio slices to the all-portfolios values', () => {
    // The one thing that agrees BY CONSTRUCTION. Rates do not add up; amounts
    // do — both come from one engine run through one fold.
    const all = composeAnalyticsView(inputs({ engineTxs: twoPortfolios, quotes: prices }));
    const scoped = ['p1', 'p2'].map((scopeId) =>
      composeAnalyticsView(inputs({ scopeId, engineTxs: twoPortfolios, quotes: prices })),
    );

    const allByPortfolio = new Map(all.breakdown.portfolio.map((s) => [s.key, s.value]));
    expect(allByPortfolio.size).toBe(2);
    for (const [index, scopeId] of ['p1', 'p2'].entries()) {
      const slices = scoped[index].breakdown.portfolio;
      expect(slices).toHaveLength(1);
      expect(slices[0].key).toBe(scopeId);
      expect(slices[0].value).toBe(allByPortfolio.get(scopeId));
      // A scope's own slice is its whole world: 100 % of itself.
      expect(slices[0].pct).toBe(fmtHundred());
    }
  });

  it('scopes the ticker dimension to the selected portfolio', () => {
    const scoped = composeAnalyticsView(
      inputs({ scopeId: 'p2', engineTxs: twoPortfolios, quotes: prices }),
    );
    expect(scoped.breakdown.ticker.map((s) => s.label)).toEqual(['MSFT']);
  });

  it('buckets an instrument with no profile as Unknown', () => {
    const view = composeAnalyticsView(inputs({ engineTxs: twoPortfolios, quotes: prices }));
    expect(view.breakdown.sector.map((s) => s.key)).toEqual(['__unknown']);
    expect(view.breakdown.sector[0].colorVar).toBe('var(--color-cat-unknown)');
  });

  it('reads the classification when there is one', () => {
    const view = composeAnalyticsView(
      inputs({
        engineTxs: twoPortfolios,
        quotes: prices,
        profiles: new Map([
          ['i-aapl', { sector: 'Electronic Computers' }],
          ['i-msft', { sector: 'Prepackaged Software' }],
        ]),
      }),
    );
    expect(view.breakdown.sector.map((s) => s.label).sort()).toEqual([
      'Electronic Computers',
      'Prepackaged Software',
    ]);
  });
});

describe('composeAnalyticsView — concentration', () => {
  it('formats the top share with the SAME spelling as the top ticker slice', () => {
    // AAPL 10 × 100 × 4 = 4 000 zł, MSFT 5 × 200 × 4 = 4 000 zł — two equal
    // holdings, so the score is exactly 50 and the top slice IS the block's
    // subject.
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [
          tx({ portfolioId: 'p1', portfolioName: 'Main', instrumentId: 'i-aapl', symbol: 'AAPL' }),
          tx({
            portfolioId: 'p2',
            portfolioName: 'IKE',
            instrumentId: 'i-msft',
            symbol: 'MSFT',
            quantity: '5',
            price: '200',
          }),
        ],
        quotes: new Map([
          ['AAPL', quote('100')],
          ['MSFT', quote('200')],
        ]),
      }),
    );
    expect(view.concentration).not.toBeNull();
    expect(view.concentration?.topSymbol).toBe(view.breakdown.ticker[0].label);
    expect(view.concentration?.topShare).toBe(view.breakdown.ticker[0].pct);
    expect(view.concentration?.score).toBe('50');
  });

  it('rounds the score half-up to an integer string', () => {
    // 3:1 split → HHI 62.5 raw (the unit test pins that), '63' formatted.
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [
          tx({ instrumentId: 'i-aapl', symbol: 'AAPL', quantity: '30', price: '100' }),
          tx({ instrumentId: 'i-msft', symbol: 'MSFT', quantity: '5', price: '200' }),
        ],
        quotes: new Map([
          ['AAPL', quote('100')],
          ['MSFT', quote('200')],
        ]),
      }),
    );
    expect(view.concentration?.score).toBe('63');
    expect(view.concentration?.topSymbol).toBe('AAPL');
  });

  it('refuses with null when nothing in the scope can be priced', () => {
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [tx({ instrumentId: 'i-cdr', symbol: 'CDR.WA', currency: 'PLN', fxRateToBase: '1' })],
        quotes: new Map(),
      }),
    );
    expect(view.concentration).toBeNull();
  });

  it('is null on the empty scope, and the empty view still parses the contract', async () => {
    // The silent breaker the plan names: `.nullable()` is still REQUIRED, so
    // a missing `concentration` in `emptyView` 500s every empty scope at the
    // route's `parse` while every populated-scope test stays green. The
    // mocked `loadHoldingsInputs` returns no rows, which is exactly the walk
    // that lands in `emptyView`.
    const view = await getAnalyticsView('user-with-nothing', undefined);
    expect(view.concentration).toBeNull();
    expect(() => analyticsResponseSchema.parse(view)).not.toThrow();
  });
});

describe('composeAnalyticsView — target drift', () => {
  const AAPL = 'i-aapl';
  const MSFT = 'i-msft';

  // AAPL 30 × 100 × 4 = 12 000 zł, MSFT 10 × 200 × 4 = 8 000 zł
  // → 20 000 zł total, a 60/40 actual split.
  const sixtyForty = [
    tx({ portfolioId: 'p1', instrumentId: AAPL, symbol: 'AAPL', quantity: '30', price: '100' }),
    tx({ portfolioId: 'p1', instrumentId: MSFT, symbol: 'MSFT', quantity: '10', price: '200' }),
  ];
  const prices = new Map([
    ['AAPL', quote('100')],
    ['MSFT', quote('200')],
  ]);

  it('spells a 60/40 actual against 50/50 targets as ±10 pp and 10% of the total', () => {
    const view = composeAnalyticsView(
      inputs({
        scopeId: 'p1',
        engineTxs: sixtyForty,
        quotes: prices,
        targets: [
          { instrumentId: AAPL, symbol: 'AAPL', targetPct: dec('50') },
          { instrumentId: MSFT, symbol: 'MSFT', targetPct: dec('50') },
        ],
      }),
    );

    const rows = view.targetDrift?.rows ?? [];
    expect(rows.map((r) => r.symbol)).toEqual(['AAPL', 'MSFT']);
    // The actual share is the SAME spelling as the ticker slice beside it.
    expect(rows[0].actual).toBe(view.breakdown.ticker[0].pct);
    expect(rows[0].drift).toBe('+10,00 pp');
    expect(rows[0].action).toBe('sell');
    expect(rows[1].drift).toBe('-10,00 pp');
    expect(rows[1].action).toBe('buy');
    // 10% of 20 000 zł, both ways — the amount is always positive and the
    // action carries the sign.
    expect(rows[0].amount).toBe(rows[1].amount);
    expect(rows[0].amount).toBe(fmtMoney(dec('2000'), 'PLN'));
    // Exactly 100 means no complaint.
    expect(view.targetDrift?.sumNote).toBeNull();
  });

  it('carries nulls — never zeros — for a held stock with no target', () => {
    const view = composeAnalyticsView(
      inputs({
        scopeId: 'p1',
        engineTxs: sixtyForty,
        quotes: prices,
        targets: [{ instrumentId: AAPL, symbol: 'AAPL', targetPct: dec('50') }],
      }),
    );

    const msft = view.targetDrift?.rows.find((r) => r.symbol === 'MSFT');
    // A fabricated 0 target would show this holding as overweight with a
    // sell order attached — the exact bug the plan names.
    expect(msft?.target).toBeNull();
    expect(msft?.drift).toBeNull();
    expect(msft?.amount).toBeNull();
    expect(msft?.action).toBeNull();
    // Its actual share is still stated, because that is a fact.
    expect(msft?.actual).toBe('+40,00%');
  });

  it('says so when the targets do not add up to 100', () => {
    const view = composeAnalyticsView(
      inputs({
        scopeId: 'p1',
        engineTxs: sixtyForty,
        quotes: prices,
        targets: [
          { instrumentId: AAPL, symbol: 'AAPL', targetPct: dec('50') },
          { instrumentId: MSFT, symbol: 'MSFT', targetPct: dec('45') },
        ],
      }),
    );

    expect(view.targetDrift?.sumNote).toBe('Targets add up to 95,00%, not 100%.');
  });

  it('is null on the All scope even with targets in hand — targets are per portfolio', () => {
    const view = composeAnalyticsView(
      inputs({
        scopeId: null,
        engineTxs: sixtyForty,
        quotes: prices,
        targets: [{ instrumentId: AAPL, symbol: 'AAPL', targetPct: dec('50') }],
      }),
    );

    expect(view.targetDrift).toBeNull();
  });

  it('is null on the empty scope, and the empty view still parses the contract', async () => {
    // The `emptyView` trap again: `.nullable()` is still REQUIRED, so a
    // missing `targetDrift` 500s every empty scope at the route's parse.
    const view = await getAnalyticsView('user-with-nothing', undefined);
    expect(view.targetDrift).toBeNull();
    expect(() => analyticsResponseSchema.parse(view)).not.toThrow();
  });
});

describe('composeAnalyticsView — series-derived figures', () => {
  const flat: ChartPoint[] = [
    point('2024-01-02', '4000'),
    point('2024-06-02', '4000'),
    point('2025-01-02', '4000'),
  ];

  it('reports a TWRR over the injected daily points', () => {
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [tx({})],
        quotes: new Map([['AAPL', quote('100')]]),
        seriesPoints: flat,
      }),
    );
    expect(view.twrrCumulative.value).not.toBe('—');
    expect(view.skippedDays).toBe(0);
  });

  it('degrades the benchmark by name when there is no SPY history', () => {
    const view = composeAnalyticsView(
      inputs({ engineTxs: [tx({})], quotes: new Map([['AAPL', quote('100')]]), seriesPoints: flat }),
    );
    expect(view.benchmark.degradedReason).toBe('no_benchmark_history');
    expect(view.benchmark.benchmark).toEqual([]);
  });

  it('draws both lines when SPY and FX cover the same days', () => {
    const spyCloses = new Map([
      ['2024-01-02', '400'],
      ['2024-06-02', '440'],
      ['2025-01-02', '480'],
    ]);
    const usdPlnByDay = new Map([
      ['2024-01-02', '4'],
      ['2024-06-02', '4'],
      ['2025-01-02', '4'],
    ]);
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [tx({})],
        quotes: new Map([['AAPL', quote('100')]]),
        seriesPoints: flat,
        spyCloses,
        usdPlnByDay,
      }),
    );
    expect(view.benchmark.degradedReason).toBeNull();
    expect(view.benchmark.portfolio).toHaveLength(3);
    expect(view.benchmark.benchmark[0].v).toBe('100');
  });

  it('refuses both TWRR figures when there is no series at all', () => {
    const view = composeAnalyticsView(
      inputs({ engineTxs: [tx({})], quotes: new Map([['AAPL', quote('100')]]) }),
    );
    expect(view.twrrAnnualized.value).toBe('—');
    expect(view.twrrCumulative.value).toBe('—');
  });
});

/** The pl-PL rendering of exactly 100 %, without restating the formatter. */
function fmtHundred(): string {
  return new Intl.NumberFormat('pl-PL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'exceptZero',
    useGrouping: 'always',
  }).format(100) + '%';
}

/**
 * Bug audit 2026-08-18, blocker 1: external flows were matched to the daily
 * axis by an EXACT date string, so a trade dated on a non-trading day
 * vanished from the chain and its money was booked as performance.
 */
describe('composeAnalyticsView — flows land on the day axis', () => {
  // A PLN instrument keeps the arithmetic in one currency: 10 × 100 = 1 000 zł
  // per buy, at a frozen rate of 1.
  const pln = (over: Partial<AnalyticsTransaction>) =>
    tx({ currency: 'PLN', fxRateToBase: '1', instrumentId: 'i-cdr', symbol: 'CDR.WA', ...over });
  const plnQuotes = new Map([['CDR.WA', quote('100', 'PLN')]]);

  it('does not book a SATURDAY deposit as performance', () => {
    // The auditor's repro: 1 000 zł bought on Saturday against a 1 000 zł
    // portfolio used to read +100 % cumulative and +5818 % annualized,
    // with nothing on screen disclosing it.
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [
          pln({ tradeDate: '2024-01-05' }),
          pln({ tradeDate: '2024-01-06' }), // Saturday: no bar, no axis day.
        ],
        quotes: plnQuotes,
        seriesPoints: [point('2024-01-05', '1000'), point('2024-01-08', '2000')],
      }),
    );
    expect(view.twrrCumulative.value).not.toBe('—');
    expect(view.twrrCumulative.direction).toBe('neutral');
    expect(view.twrrCumulative.value).toContain('0,00');
  });

  it('does not book a market-HOLIDAY deposit as performance either', () => {
    // 2024-01-15 was Martin Luther King Jr. Day: a weekday with no bar.
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [pln({ tradeDate: '2024-01-12' }), pln({ tradeDate: '2024-01-15' })],
        quotes: plnQuotes,
        seriesPoints: [point('2024-01-12', '1000'), point('2024-01-16', '2000')],
      }),
    );
    expect(view.twrrCumulative.direction).toBe('neutral');
    expect(view.twrrCumulative.value).toContain('0,00');
  });

  it('carries a flow dated before the axis onto its first day', () => {
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [pln({ tradeDate: '2023-12-28' }), pln({ tradeDate: '2024-01-05' })],
        quotes: plnQuotes,
        // The curve only starts once both buys are in it.
        seriesPoints: [point('2024-01-05', '2000'), point('2024-02-05', '2200')],
      }),
    );
    // 2 000 → 2 200 with both deposits on the first day: +10 %, not +120 %.
    expect(view.twrrCumulative.value).toContain('10,00');
  });

  it('REFUSES the time-weighted return when money is dated past the last priced day', () => {
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [pln({ tradeDate: '2024-01-05' }), pln({ tradeDate: '2024-03-01' })],
        quotes: plnQuotes,
        seriesPoints: [point('2024-01-05', '1000'), point('2024-02-05', '1100')],
      }),
    );
    // A disclosed refusal, never a silent zero and never a flattering figure.
    expect(view.twrrCumulative.value).toBe('—');
    expect(view.twrrAnnualized.value).toBe('—');
    expect(view.twrrCumulative.note).toContain('outside the days');
  });
});

/**
 * Bug audit 2026-08-18, blocker 2 and major 5: the valuation series applied
 * its OWN exclusions, which were discarded, so the value curve and the
 * cash-flow stream could describe different instrument sets.
 */
describe('composeAnalyticsView — ONE exclusion set', () => {
  const mixed: AnalyticsTransaction[] = [
    tx({ instrumentId: 'i-aapl', symbol: 'AAPL' }),
    tx({ instrumentId: 'i-msft', symbol: 'MSFT', quantity: '5', price: '200' }),
  ];
  const prices = new Map([
    ['AAPL', quote('100')],
    ['MSFT', quote('200')],
  ]);

  it('names a holding the value curve could not carry, with its own reason', () => {
    const view = composeAnalyticsView(
      inputs({ engineTxs: mixed, quotes: prices, seriesExcludedSymbols: ['MSFT'] }),
    );
    expect(view.excludedSymbols).toEqual([{ symbol: 'MSFT', reason: 'no_price_history' }]);
    // …and it stays OUT of the time series while staying IN the snapshot
    // (bug audit 2026-08-19, major 2): the tiles and the slices are today's
    // quotes, which this holding has.
    expect(view.breakdown.ticker.map((s) => s.label).sort()).toEqual(['AAPL', 'MSFT']);
  });

  it('drops a CLOSED holding from the flows when the curve cannot carry it', () => {
    // The mismatch that reads as a large loss: its buy moves the chain's
    // denominator on a day the curve never valued it.
    const closed: AnalyticsTransaction[] = [
      tx({ instrumentId: 'i-cdr', symbol: 'CDR.WA', currency: 'PLN', fxRateToBase: '1' }),
      tx({
        instrumentId: 'i-cdr',
        symbol: 'CDR.WA',
        currency: 'PLN',
        fxRateToBase: '1',
        side: 'sell',
        price: '150',
        tradeDate: '2025-01-02',
      }),
    ];
    const included = composeAnalyticsView(inputs({ engineTxs: closed, quotes: new Map() }));
    const excluded = composeAnalyticsView(
      inputs({ engineTxs: closed, quotes: new Map(), seriesExcludedSymbols: ['CDR.WA'] }),
    );

    // Without the series exclusion the closed position stays in and solves.
    expect(included.xirr.note).toBeNull();
    // With it, every one of its flows is gone — and the screen says why.
    expect(excluded.excludedSymbols).toEqual([
      { symbol: 'CDR.WA', reason: 'no_price_history' },
    ]);
    expect(excluded.xirr.value).toBe('—');
  });

  it('states the same instrument set for the flows and the curve', () => {
    // The invariant, asserted at the seam the impure walk shares with the
    // composer: one call decides both.
    const runs = runEnginePerPortfolio(mixed, prices, new Map([['USD', '4']]));
    const exclusions = resolveExclusions(runs, ['MSFT'], prices, new Map([['USD', '4']]));
    expect([...exclusions.seriesInstrumentIds]).toEqual(['i-msft']);
    // …and nothing is taken away from the snapshot surfaces by a history gap.
    expect([...exclusions.snapshotInstrumentIds]).toEqual([]);
    expect(exclusions.symbols).toEqual([{ symbol: 'MSFT', reason: 'no_price_history' }]);
  });

  it('prefers the "no price history" wording when a holding fails both ways', () => {
    const runs = runEnginePerPortfolio(mixed, new Map([['AAPL', quote('100')]]), new Map([['USD', '4']]));
    const exclusions = resolveExclusions(runs, ['MSFT'], new Map([['AAPL', quote('100')]]), new Map([['USD', '4']]));
    expect(exclusions.symbols).toEqual([{ symbol: 'MSFT', reason: 'no_price_history' }]);
  });
});

/**
 * Bug audit 2026-08-18, minor 6: "priced value" came from the per-portfolio
 * runs and "unrealized gain" from a separate combined run, so an oversell in
 * one portfolio made the two tiles describe different quantity sets.
 */
describe('composeAnalyticsView — the tiles and the slices are one run', () => {
  it('states the same quantity set in both tiles when a portfolio oversells', () => {
    const oversold: AnalyticsTransaction[] = [
      tx({ portfolioId: 'p1', portfolioName: 'Main', quantity: '10', price: '100' }),
      // p2 sells shares it never held: a per-portfolio run clamps at zero, a
      // combined run would eat p1's shares.
      tx({ portfolioId: 'p2', portfolioName: 'IKE', side: 'sell', quantity: '5', price: '100' }),
    ];
    const view = composeAnalyticsView(
      inputs({ engineTxs: oversold, quotes: new Map([['AAPL', quote('100')]]) }),
    );
    // 10 shares × 100 USD × 4 = 4 000 zł, stated once and used everywhere.
    expect(view.totalValue).toBe(view.breakdown.ticker[0].value);
    expect(view.breakdown.portfolio.map((s) => s.key)).toEqual(['p1']);
    expect(view.totalGain).not.toBeNull();
  });

  it('dates the terminal valuation no earlier than the last trade it values', () => {
    // The clock convention: "today" is the New York date, while a trade
    // entered on a Warsaw evening already carries the next day's date.
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [tx({ tradeDate: '2024-01-02' })],
        quotes: new Map([['AAPL', quote('200')]]),
        todayISO: '2026-08-18',
      }),
    );
    const tomorrow = composeAnalyticsView(
      inputs({
        engineTxs: [tx({ tradeDate: '2026-08-19' })],
        quotes: new Map([['AAPL', quote('200')]]),
        todayISO: '2026-08-18',
      }),
    );
    expect(view.xirr.note).toBeNull();
    // A same-day round trip is too short to annualize — but it must REFUSE by
    // name, not throw or invert the flow order.
    expect(tomorrow.xirr.note).toBe('Less than 30 days of history.');
  });
});

/**
 * Bug audit 2026-08-19, major 2: the single exclusion set was applied to the
 * VALUE TILES and the ALLOCATION as well, which need today's quotes and no
 * daily bars at all. On a cold history cache the 13th alphabetical symbol
 * falls past `MAX_BACKFILL_SYMBOLS` and returns an empty close map — so a
 * real, live-priced holding vanished from "priced value", from "unrealized
 * gain" and from every allocation denominator, and healed itself over the
 * next few page loads.
 */
describe('composeAnalyticsView — a history gap does not shrink the snapshot', () => {
  // Thirteen symbols, alphabetically ordered; only the first twelve get their
  // history backfilled, so the thirteenth comes back with no daily closes.
  const SYMBOLS = ['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM'];
  const COLD = SYMBOLS[12];

  const held = SYMBOLS.map((symbol) =>
    tx({
      instrumentId: `i-${symbol}`,
      symbol,
      currency: 'PLN',
      fxRateToBase: '1',
      quantity: '10',
      price: '100',
    }),
  );
  const quotes = new Map(SYMBOLS.map((symbol) => [symbol, quote('100', 'PLN')]));

  const view = composeAnalyticsView(
    inputs({
      engineTxs: held,
      quotes,
      // Everything the backfill bound could not reach.
      seriesExcludedSymbols: [COLD],
      seriesPoints: [point('2024-01-02', '12000'), point('2025-01-02', '13200')],
    }),
  );

  it('counts the cold symbol in the allocation at its full value', () => {
    const cold = view.breakdown.ticker.find((slice) => slice.label === COLD);
    expect(cold).toBeDefined();
    expect(view.breakdown.ticker).toHaveLength(13);
    // 13 × 1 000 zł, all thirteen in the denominator — not 12.
    expect(view.totalValue).toBe(view.breakdown.currency[0].value);
  });

  it('counts it in the value tiles too', () => {
    expect(view.totalValue).toContain('13');
    expect(view.totalGain).not.toBeNull();
  });

  it('still keeps it out of the TWRR chain, and still names it there', () => {
    // The time series genuinely cannot carry it, so it is out of the flows and
    // out of the curve — and the screen says so with its own reason.
    expect(view.excludedSymbols).toEqual([{ symbol: COLD, reason: 'no_price_history' }]);
    const runs = runEnginePerPortfolio(held, quotes, new Map());
    const exclusions = resolveExclusions(runs, [COLD], quotes, new Map());
    expect([...exclusions.seriesInstrumentIds]).toEqual([`i-${COLD}`]);
    expect([...exclusions.snapshotInstrumentIds]).toEqual([]);
  });
});

/**
 * Bug audit 2026-08-19, minor 3: the terminal XIRR flow was dated
 * `max(nyToday, lastFlowDate)` with NO upper bound, so a trade typo'd years
 * into the future discounted today's value over that whole span and quietly
 * halved the reported rate.
 */
describe('composeAnalyticsView — the terminal valuation is clamped', () => {
  const buy = tx({
    instrumentId: 'i-cdr',
    symbol: 'CDR.WA',
    currency: 'PLN',
    fxRateToBase: '1',
    quantity: '10',
    price: '100',
    tradeDate: '2020-08-18',
  });
  const quotes = new Map([['CDR.WA', quote('150', 'PLN')]]);

  it('does not let a far-future trade date stretch the discount window', () => {
    const sane = composeAnalyticsView(
      inputs({ engineTxs: [buy], quotes, todayISO: '2026-08-18' }),
    );
    const typo = composeAnalyticsView(
      inputs({
        engineTxs: [
          buy,
          // A one-grosz sale typo'd nine years out. Its own amount is noise;
          // what used to matter is that it dragged the TERMINAL valuation to
          // 2035 with it, discounting today's 1 500 zł over fifteen years
          // instead of six and halving the reported rate.
          tx({ ...buy, side: 'sell', tradeDate: '2035-01-15', quantity: '0.0001', price: '100' }),
        ],
        quotes,
        todayISO: '2026-08-18',
      }),
    );
    expect(sane.xirr.note).toBeNull();
    expect(typo.xirr.note).toBeNull();
    // The clamp holds the terminal date at one day past today, so the typo
    // moves the rate by a hundredth of a point (the extra day) instead of
    // dragging it from ~7 %/yr down to ~2.7 %/yr.
    expect(sane.xirr.value.startsWith('+6,9')).toBe(true);
    expect(typo.xirr.value.startsWith('+6,9')).toBe(true);
  });

  it('still dates the terminal flow a day forward for the Warsaw/NY skew', () => {
    // A trade entered on a Warsaw evening carries tomorrow's NY date, and the
    // terminal valuation must not be dated before a trade it already values.
    const view = composeAnalyticsView(
      inputs({
        engineTxs: [buy, tx({ ...buy, tradeDate: '2026-08-19', quantity: '1' })],
        quotes,
        todayISO: '2026-08-18',
      }),
    );
    expect(view.xirr.note).toBeNull();
    expect(view.xirr.direction).toBe('gain');
  });
});
