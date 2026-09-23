import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nyDateISOAt } from '@/lib/market-data/market-clock';
import type { Candle, Quote } from '@/lib/market-data/provider';
import type { EngineTransaction } from '@/lib/position-engine';
import { computePositions } from '@/lib/position-engine';

/**
 * Tests for the PURE series builders — closes, FX and a (spy-able) engine are
 * injected, so no Drizzle mocking. The framework boundaries are stubbed only
 * so the `server-only` module can be imported at all.
 */

const h = vi.hoisted(() => ({ txRows: [] as unknown[] }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) {
      chain[method] = vi.fn(self);
    }
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(h.txRows).then(resolve, reject);
    return chain;
  };
  return {
    db: { select: vi.fn(() => makeChain()) },
    instruments: {},
    portfolios: {},
    transactions: {},
  };
});
vi.mock('@/lib/fx/nbp', () => ({
  getCurrentFxRateToPln: vi.fn(),
  getFxRatesForRange: vi.fn(),
}));
vi.mock('@/lib/market-data/massive', () => ({
  massiveProvider: {
    getAggregates: vi.fn(),
    getQuotes: vi.fn(),
    getCalendarOverrides: vi.fn(),
  },
}));
vi.mock('./price-history', () => ({
  getDailyBars: vi.fn(),
  getDailyCloses: vi.fn(),
  getLatestClosesBefore: vi.fn(),
  MAX_BACKFILL_SYMBOLS: 12,
}));

import * as formingDay from '@/lib/charts/forming-day';
import { getFxRatesForRange } from '@/lib/fx/nbp';
import { massiveProvider } from '@/lib/market-data/massive';

import {
  buildDailyPortfolioSeries,
  buildIntradayPortfolioSeries,
  getInstrumentPriceSeries,
  getPortfolioValueSeries,
  loadDailyClosesByInstrument,
  loadIntradayCandles,
} from './portfolio-series';
import { getDailyBars, getDailyCloses, MAX_BACKFILL_SYMBOLS } from './price-history';

let txSeq = 0;

function tx(overrides: Partial<EngineTransaction> & { instrumentId: string }): EngineTransaction {
  txSeq++;
  return {
    id: `tx-${txSeq}`,
    symbol: overrides.instrumentId.toUpperCase(),
    displayName: overrides.instrumentId,
    currency: 'USD',
    side: 'buy',
    quantity: '10',
    price: '100',
    fees: '0',
    fxRateToBase: '4',
    tradeDate: '2026-08-03',
    createdAt: new Date('2026-08-03T12:00:00Z'),
    ...overrides,
  };
}

function closes(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

/** Dense FX map over consecutive days. */
function fxDense(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

const WINDOW = { from: '2026-08-03', to: '2026-08-05' };

describe('buildDailyPortfolioSeries — multi-currency arithmetic', () => {
  it('a USD + PLN portfolio sums quantity × close × rate exactly', () => {
    const txs = [
      tx({ instrumentId: 'aapl', currency: 'USD', quantity: '10' }),
      tx({ instrumentId: 'pkn', symbol: 'PKN', currency: 'PLN', quantity: '5', price: '60' }),
    ];
    const result = buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '100'], ['2026-08-04', '110']])],
        ['pkn', closes([['2026-08-03', '60'], ['2026-08-04', '62']])],
      ]),
      fxByCurrency: new Map([
        ['USD', fxDense([['2026-08-03', '4'], ['2026-08-04', '4.1'], ['2026-08-05', '4.1']])],
      ]),
      window: WINDOW,
    });

    // Day 1: 10×100×4 + 5×60×1 = 4300. Day 2: 10×110×4.1 + 5×62×1 = 4820.
    expect(result.points.map((p) => p.v)).toEqual(['4300', '4820']);
    expect(result.partialDays).toBe(0);
    expect(result.excludedSymbols).toEqual([]);
    // Decimal-string discipline: values leave as strings, always.
    for (const point of result.points) expect(typeof point.v).toBe('string');
  });

  it('a day one instrument has not traded yet is PARTIAL, never a silent undercount', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10' }),
      tx({ instrumentId: 'ipo', symbol: 'IPO', quantity: '2', price: '50' }),
    ];
    const result = buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '100'], ['2026-08-04', '100']])],
        // IPO's first close arrives only on day 2 — day 1 has no carry seed.
        ['ipo', closes([['2026-08-04', '50']])],
      ]),
      fxByCurrency: new Map([
        ['USD', fxDense([['2026-08-03', '4'], ['2026-08-04', '4'], ['2026-08-05', '4']])],
      ]),
      window: WINDOW,
    });

    expect(result.partialDays).toBe(1);
    // Day 1 carries only AAPL (4000); day 2 has both (4000 + 400).
    expect(result.points.map((p) => p.v)).toEqual(['4000', '4400']);
  });

  it('an instrument with no close in the whole window is EXCLUDED and the rest stays intact', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10' }),
      tx({ instrumentId: 'cdr', symbol: 'CDR.WA', currency: 'USD', quantity: '100' }),
    ];
    const result = buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '100'], ['2026-08-04', '110']])],
        ['cdr', closes([])],
      ]),
      fxByCurrency: new Map([
        ['USD', fxDense([['2026-08-03', '4'], ['2026-08-04', '4'], ['2026-08-05', '4']])],
      ]),
      window: WINDOW,
    });

    expect(result.excludedSymbols).toEqual(['CDR.WA']);
    // The excluded instrument neither zeroes the sum nor marks days partial.
    expect(result.points.map((p) => p.v)).toEqual(['4000', '4400']);
    expect(result.partialDays).toBe(0);
  });

  it('a currency with no FX data excludes its instruments the same way', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10' }),
      tx({ instrumentId: 'sap', symbol: 'SAP', currency: 'EUR', quantity: '3' }),
    ];
    const result = buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '100']])],
        ['sap', closes([['2026-08-03', '200']])],
      ]),
      fxByCurrency: new Map([['USD', fxDense([['2026-08-03', '4']])]]),
      window: WINDOW,
    });

    expect(result.excludedSymbols).toEqual(['SAP']);
    expect(result.points.map((p) => p.v)).toEqual(['4000']);
  });

  it('calls the engine once per unique trade date in the window — not once per day', () => {
    // Three transactions on TWO distinct dates, charted over a long window.
    const txs = [
      tx({ instrumentId: 'aapl', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'aapl', tradeDate: '2026-08-03', quantity: '5' }),
      tx({ instrumentId: 'aapl', tradeDate: '2026-08-05', side: 'sell', quantity: '5' }),
    ];
    const engine = vi.fn(computePositions);

    const closesMap = closes([
      ['2026-08-03', '100'],
      ['2026-08-04', '100'],
      ['2026-08-05', '100'],
      ['2026-08-06', '100'],
      ['2026-08-07', '100'],
    ]);
    buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([['aapl', closesMap]]),
      fxByCurrency: new Map([
        ['USD', fxDense([...closesMap.keys()].map((d) => [d, '4'] as [string, string]))],
      ]),
      window: { from: '2026-08-03', to: '2026-08-07' },
      engine,
    });

    const uniqueTradeDates = new Set(txs.map((t) => t.tradeDate)).size;
    expect(engine).toHaveBeenCalledTimes(uniqueTradeDates);
  });

  it('selling to zero removes the contribution from the sell date onward', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'aapl', side: 'sell', quantity: '10', tradeDate: '2026-08-04' }),
    ];
    const result = buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '100'], ['2026-08-04', '100'], ['2026-08-05', '100']])],
      ]),
      fxByCurrency: new Map([
        ['USD', fxDense([['2026-08-03', '4'], ['2026-08-04', '4'], ['2026-08-05', '4']])],
      ]),
      window: WINDOW,
    });

    // Position quantities take effect at end of their trade date: held on the
    // 3rd, flat from the 4th on.
    expect(result.points.map((p) => p.v)).toEqual(['4000', '0', '0']);
  });

  it('a transaction dated after the window end does not touch the series or the engine', () => {
    const inWindow = [tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-03' })];
    const withFuture = [
      ...inWindow,
      tx({ instrumentId: 'aapl', quantity: '90', tradeDate: '2026-09-01' }),
    ];
    const engine = vi.fn(computePositions);

    const inputs = (txs: EngineTransaction[]) => ({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '100'], ['2026-08-04', '110']])],
      ]),
      fxByCurrency: new Map([
        ['USD', fxDense([['2026-08-03', '4'], ['2026-08-04', '4'], ['2026-08-05', '4']])],
      ]),
      window: WINDOW,
      engine,
    });

    const base = buildDailyPortfolioSeries(inputs(inWindow));
    const engineCallsForBase = engine.mock.calls.length;
    const withFutureResult = buildDailyPortfolioSeries(inputs(withFuture));

    expect(withFutureResult.points).toEqual(base.points);
    // The future date added ZERO engine calls.
    expect(engine.mock.calls.length).toBe(engineCallsForBase * 2);
  });
});

describe('buildIntradayPortfolioSeries', () => {
  const bar = (iso: string, close: string) => ({
    t: Date.parse(iso),
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
  });

  it('sums the newest bar at or before each instant, per instrument', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'spy', symbol: 'SPY', quantity: '1', tradeDate: '2026-08-03' }),
    ];
    const result = buildIntradayPortfolioSeries({
      txs,
      candlesByInstrument: new Map([
        ['aapl', [bar('2026-08-04T14:00:00Z', '100'), bar('2026-08-04T14:05:00Z', '101')]],
        // SPY has no 14:05 bar — its 14:00 close carries forward.
        ['spy', [bar('2026-08-04T14:00:00Z', '500')]],
      ]),
      sessions: 1,
      fxRateByCurrency: new Map([['USD', '4']]),
      window: { from: '2026-08-03', to: '2026-08-04' },
    });

    // 14:00: (10×100 + 1×500)×4 = 6000. 14:05: (10×101 + 1×500)×4 = 6040.
    expect(result.points.map((p) => p.v)).toEqual(['6000', '6040']);
    expect(result.partialDays).toBe(0);
  });

  it('an instrument with no intraday bars at all is excluded, like the daily series', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'cdr', symbol: 'CDR.WA', quantity: '100', tradeDate: '2026-08-03' }),
    ];
    const result = buildIntradayPortfolioSeries({
      txs,
      candlesByInstrument: new Map([
        ['aapl', [bar('2026-08-04T14:00:00Z', '100')]],
        // Raw-empty: no bars at all, anywhere in the fetch window.
        ['cdr', []],
      ]),
      sessions: 1,
      fxRateByCurrency: new Map([['USD', '4']]),
      window: { from: '2026-08-03', to: '2026-08-04' },
    });

    expect(result.excludedSymbols).toEqual(['CDR.WA']);
    expect(result.points.map((p) => p.v)).toEqual(['4000']);
  });

  it('a pre-window baseline close seeds carry-forward — a late first bar never sinks the window start', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'msft', symbol: 'MSFT', quantity: '2', tradeDate: '2026-08-03' }),
    ];
    const result = buildIntradayPortfolioSeries({
      txs,
      candlesByInstrument: new Map([
        ['aapl', [bar('2026-08-04T14:00:00Z', '100'), bar('2026-08-04T14:05:00Z', '101')]],
        // MSFT prints its FIRST bar only at 14:05 — mid-shared-window.
        ['msft', [bar('2026-08-04T14:05:00Z', '300')]],
      ]),
      sessions: 1,
      fxRateByCurrency: new Map([['USD', '4']]),
      // Yesterday's daily close from price_snapshots.
      baselineCloseByInstrument: new Map([['msft', '290']]),
      window: { from: '2026-08-03', to: '2026-08-04' },
    });

    // 14:00: (10×100 + 2×290)×4 = 6320 — MSFT counts from the FIRST instant.
    // 14:05: (10×101 + 2×300)×4 = 6440 — its own bar overwrites the seed.
    expect(result.points.map((p) => p.v)).toEqual(['6320', '6440']);
    expect(result.partialDays).toBe(0);
  });

  it('without a baseline the late starter still marks early instants partial — the old behavior', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'msft', symbol: 'MSFT', quantity: '2', tradeDate: '2026-08-03' }),
    ];
    const result = buildIntradayPortfolioSeries({
      txs,
      candlesByInstrument: new Map([
        ['aapl', [bar('2026-08-04T14:00:00Z', '100'), bar('2026-08-04T14:05:00Z', '101')]],
        ['msft', [bar('2026-08-04T14:05:00Z', '300')]],
      ]),
      sessions: 1,
      fxRateByCurrency: new Map([['USD', '4']]),
      window: { from: '2026-08-03', to: '2026-08-04' },
    });

    expect(result.points.map((p) => p.v)).toEqual(['4000', '6440']);
    expect(result.partialDays).toBe(1);
  });

  it('with sessionOverrides (1D), points outside regular hours get phase tags — values untouched', () => {
    const txs = [tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-03' })];
    const inputs = {
      txs,
      // 2026-08-04 is a Tuesday; EDT regular session is 13:30–20:00 UTC.
      candlesByInstrument: new Map([
        [
          'aapl',
          [
            bar('2026-08-04T12:00:00Z', '100'), // 08:00 ET — pre-market
            bar('2026-08-04T14:00:00Z', '101'), // 10:00 ET — regular
            bar('2026-08-04T21:00:00Z', '102'), // 17:00 ET — after hours
          ],
        ],
      ]),
      sessions: 1,
      fxRateByCurrency: new Map([['USD', '4']]),
      window: { from: '2026-08-03', to: '2026-08-04' },
    };

    // `[]` means the standard NYSE weekday schedule (no overrides) — a
    // meaningful value, distinct from omitting the field entirely.
    const result = buildIntradayPortfolioSeries({ ...inputs, sessionOverrides: [] });

    expect(result.points.map((p) => p.p)).toEqual(['pre', undefined, 'post']);
    // Tags never touch money: identical sums with or without tagging.
    const untagged = buildIntradayPortfolioSeries(inputs);
    expect(result.points.map((p) => p.v)).toEqual(untagged.points.map((p) => p.v));
    expect(result.points.map((p) => p.v)).toEqual(['4000', '4040', '4080']);
  });

  it('without sessionOverrides (non-1D), no point carries a phase tag at all', () => {
    const txs = [tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-03' })];
    const result = buildIntradayPortfolioSeries({
      txs,
      candlesByInstrument: new Map([
        [
          'aapl',
          [
            bar('2026-08-04T12:00:00Z', '100'),
            bar('2026-08-04T14:00:00Z', '101'),
            bar('2026-08-04T21:00:00Z', '102'),
          ],
        ],
      ]),
      sessions: 1,
      fxRateByCurrency: new Map([['USD', '4']]),
      window: { from: '2026-08-03', to: '2026-08-04' },
    });

    // Absent means absent — not `undefined`-valued. Serialization stays
    // byte-identical for the non-1D payloads.
    expect(result.points.every((p) => !('p' in p))).toBe(true);
  });

  it('a transaction two days back changes the contribution from that session on', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-04' }),
    ];
    const result = buildIntradayPortfolioSeries({
      txs,
      candlesByInstrument: new Map([
        [
          'aapl',
          [
            bar('2026-08-03T14:00:00Z', '100'), // held 10
            bar('2026-08-04T14:00:00Z', '100'), // held 20
          ],
        ],
      ]),
      sessions: 2,
      fxRateByCurrency: new Map([['USD', '4']]),
      window: { from: '2026-08-03', to: '2026-08-04' },
    });

    expect(result.points.map((p) => p.v)).toEqual(['4000', '8000']);
  });

  it('slices every instrument to ONE shared trailing session — bars on different NY dates cannot mix', () => {
    // The 2026-08-14 pre-market artifact: instrument A has already printed
    // today's pre-market bars while quiet B still holds a full yesterday.
    // Pre-fix, each instrument charted its OWN trailing session, so the axis
    // glued all of yesterday (both) to today's pre-market (A only) — a
    // vertical cliff exactly one instrument's pre-market move tall. The fix
    // charts the newest day ANY instrument printed, for everyone.
    const txs = [
      tx({ instrumentId: 'a', symbol: 'AAA', quantity: '1', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'b', symbol: 'BBB', quantity: '1', tradeDate: '2026-08-03' }),
    ];
    const result = buildIntradayPortfolioSeries({
      txs,
      candlesByInstrument: new Map([
        [
          'a',
          [
            // Thursday 2026-08-13, regular session (14:30Z = 10:30 ET).
            bar('2026-08-13T14:30:00Z', '100'),
            bar('2026-08-13T15:00:00Z', '101'),
            // Friday 2026-08-14, pre-market (09:00Z = 05:00 ET).
            bar('2026-08-14T09:00:00Z', '110'),
            bar('2026-08-14T09:05:00Z', '112'),
          ],
        ],
        // B has printed NOTHING today — its whole day-1 session is raw input.
        ['b', [bar('2026-08-13T14:30:00Z', '50'), bar('2026-08-13T15:00:00Z', '51')]],
      ]),
      sessions: 1,
      fxRateByCurrency: new Map([['USD', '4']]),
      window: { from: '2026-08-08', to: '2026-08-14' },
    });

    // Every charted instant is on the SHARED trailing day — 2026-08-14. The
    // pre-fix builder charts both days here, so this assertion fails there.
    expect(result.points.map((p) => nyDateISOAt(p.t))).toEqual(['2026-08-14', '2026-08-14']);
    // Point count is exactly A's day-2 bar count — no yesterday instants.
    expect(result.points).toHaveLength(2);
    // B holds flat at its last day-1 close (51): no cliff instant exists.
    // 09:00: 1×110×4 + 1×51×4 = 644. 09:05: 1×112×4 + 1×51×4 = 652.
    expect(result.points.map((p) => p.v)).toEqual(['644', '652']);
    // B is INCLUDED (carry-forward), not excluded, and no instant is partial.
    expect(result.excludedSymbols).toEqual([]);
    expect(result.partialDays).toBe(0);
  });

  it('sessions: 2 (the 5D shape) — the shared window is the trailing two dates of the UNION', () => {
    // Union dates are day0/day1/day2 across two instruments: X printed
    // day0+day1, Y printed day1+day2. Trailing 2 of the union → day1+day2;
    // X (missing day2) carries forward, Y (missing day0) is unaffected.
    const txs = [
      tx({ instrumentId: 'x', symbol: 'XXX', quantity: '1', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'y', symbol: 'YYY', quantity: '1', tradeDate: '2026-08-03' }),
    ];
    const result = buildIntradayPortfolioSeries({
      txs,
      candlesByInstrument: new Map([
        ['x', [bar('2026-08-11T14:30:00Z', '10'), bar('2026-08-12T14:30:00Z', '11')]],
        ['y', [bar('2026-08-12T14:30:00Z', '20'), bar('2026-08-13T14:30:00Z', '21')]],
      ]),
      sessions: 2,
      fxRateByCurrency: new Map([['USD', '1']]),
      window: { from: '2026-08-08', to: '2026-08-13' },
    });

    // Axis covers exactly day1 + day2 — day0 (2026-08-11) is out.
    expect(result.points.map((p) => nyDateISOAt(p.t))).toEqual(['2026-08-12', '2026-08-13']);
    // Day1: 11 + 20 = 31. Day2: X carries 11, Y prints 21 → 32.
    expect(result.points.map((p) => p.v)).toEqual(['31', '32']);
    expect(result.excludedSymbols).toEqual([]);
    expect(result.partialDays).toBe(0);
  });

  it('a baseline still seeds instruments whose first-ever bar lands mid-shared-window', () => {
    // N's first bar EVER is mid-way through the shared day; the pre-window
    // daily close covers the early instants, so nothing is partial.
    const txs = [
      tx({ instrumentId: 'a', symbol: 'AAA', quantity: '1', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'n', symbol: 'NNN', quantity: '1', tradeDate: '2026-08-03' }),
    ];
    const result = buildIntradayPortfolioSeries({
      txs,
      candlesByInstrument: new Map([
        [
          'a',
          [
            bar('2026-08-13T14:30:00Z', '100'),
            bar('2026-08-14T09:00:00Z', '110'),
            bar('2026-08-14T09:05:00Z', '112'),
          ],
        ],
        ['n', [bar('2026-08-14T09:05:00Z', '30')]],
      ]),
      sessions: 1,
      fxRateByCurrency: new Map([['USD', '1']]),
      baselineCloseByInstrument: new Map([['n', '29']]),
      window: { from: '2026-08-08', to: '2026-08-14' },
    });

    // 09:00: 110 + seed 29 = 139. 09:05: 112 + own bar 30 = 142.
    expect(result.points.map((p) => p.v)).toEqual(['139', '142']);
    expect(result.partialDays).toBe(0);
  });
});

describe('return curve (`r`) — simple percent vs open PLN cost basis', () => {
  it('buy-and-hold: each point carries (value − basis) / basis × 100 as an exact decimal string', () => {
    // Basis: 10 × 100 × fx 4 = 4000 PLN, frozen at the trade-date rate.
    const txs = [tx({ instrumentId: 'aapl', quantity: '10', price: '100', fxRateToBase: '4' })];
    const result = buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '100'], ['2026-08-04', '110']])],
      ]),
      fxByCurrency: new Map([
        ['USD', fxDense([['2026-08-03', '4'], ['2026-08-04', '4.1']])],
      ]),
      window: WINDOW,
    });

    // Day 1: v 4000 vs basis 4000 → 0%. Day 2: v 4510 vs 4000 → 12.75%.
    expect(result.points.map((p) => p.v)).toEqual(['4000', '4510']);
    expect(result.points.map((p) => p.r)).toEqual(['0', '12.75']);
    for (const point of result.points) expect(typeof point.r).toBe('string');
  });

  it('days before the first buy carry NO `r` at all — never a fake flat 0%', () => {
    const txs = [tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-04' })];
    const result = buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '100'], ['2026-08-04', '100']])],
      ]),
      fxByCurrency: new Map([
        ['USD', fxDense([['2026-08-03', '4'], ['2026-08-04', '4']])],
      ]),
      window: WINDOW,
    });

    // The pre-ownership day exists on the value axis but has no return.
    expect(result.points.map((p) => p.v)).toEqual(['0', '4000']);
    expect('r' in result.points[0]).toBe(false);
    expect(result.points[1].r).toBe('0');
  });

  it('a second buy at the market price steps `r` toward zero on the boundary day', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10', price: '100', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'aapl', quantity: '5', price: '200', tradeDate: '2026-08-04' }),
    ];
    const result = buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '200'], ['2026-08-04', '200']])],
      ]),
      fxByCurrency: new Map([
        ['USD', fxDense([['2026-08-03', '4'], ['2026-08-04', '4']])],
      ]),
      window: WINDOW,
    });

    // Day 1: v 8000 vs basis 4000 → +100%. Day 2: the buy adds 4000 to BOTH
    // value and basis (12000 vs 8000) → +50% — the same 4000 PLN gain spread
    // over a bigger outlay, no market move involved.
    expect(result.points.map((p) => p.v)).toEqual(['8000', '12000']);
    expect(result.points.map((p) => p.r)).toEqual(['100', '50']);
  });

  it('an instrument skipped for value (no carry-forward close yet) contributes no basis either', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10', price: '100' }),
      tx({ instrumentId: 'ipo', symbol: 'IPO', quantity: '2', price: '50' }),
    ];
    const result = buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '100'], ['2026-08-04', '100']])],
        // IPO's first close arrives only on day 2 — day 1 has no carry seed.
        ['ipo', closes([['2026-08-04', '50']])],
      ]),
      fxByCurrency: new Map([
        ['USD', fxDense([['2026-08-03', '4'], ['2026-08-04', '4']])],
      ]),
      window: WINDOW,
    });

    // Day 1 is AAPL-only on both sides of the ratio: 4000 vs 4000 → 0%, not
    // the −9.09% that counting IPO's basis against a value it never joined
    // would produce. Day 2 has both: 4400 vs 4400 → 0%.
    expect(result.partialDays).toBe(1);
    expect(result.points.map((p) => p.v)).toEqual(['4000', '4400']);
    expect(result.points.map((p) => p.r)).toEqual(['0', '0']);
  });

  it('intraday: `r` follows the bars against a fixed within-session basis', () => {
    const bar = (iso: string, close: string) => ({
      t: Date.parse(iso),
      open: close,
      high: close,
      low: close,
      close,
      volume: '1',
    });
    const txs = [tx({ instrumentId: 'aapl', quantity: '10', price: '100', tradeDate: '2026-08-03' })];
    const result = buildIntradayPortfolioSeries({
      txs,
      candlesByInstrument: new Map([
        ['aapl', [bar('2026-08-04T14:00:00Z', '100'), bar('2026-08-04T14:05:00Z', '101')]],
      ]),
      sessions: 1,
      fxRateByCurrency: new Map([['USD', '4']]),
      window: { from: '2026-08-03', to: '2026-08-04' },
    });

    // Basis is 4000 at BOTH instants (no trade date inside the session); only
    // the value moves: 4000 → 0%, 4040 → +1%.
    expect(result.points.map((p) => p.v)).toEqual(['4000', '4040']);
    expect(result.points.map((p) => p.r)).toEqual(['0', '1']);
  });

  it('full liquidation mid-window: trailing points carry no `r`', () => {
    const txs = [
      tx({ instrumentId: 'aapl', quantity: '10', tradeDate: '2026-08-03' }),
      tx({ instrumentId: 'aapl', side: 'sell', quantity: '10', tradeDate: '2026-08-04' }),
    ];
    const result = buildDailyPortfolioSeries({
      txs,
      closesByInstrument: new Map([
        ['aapl', closes([['2026-08-03', '100'], ['2026-08-04', '100'], ['2026-08-05', '100']])],
      ]),
      fxByCurrency: new Map([
        ['USD', fxDense([['2026-08-03', '4'], ['2026-08-04', '4'], ['2026-08-05', '4']])],
      ]),
      window: WINDOW,
    });

    // Held on the 3rd (0%); flat from the 4th on — zero basis, so the return
    // is undefined and the field is simply absent, never a zero.
    expect(result.points.map((p) => p.v)).toEqual(['4000', '0', '0']);
    expect(result.points[0].r).toBe('0');
    expect('r' in result.points[1]).toBe(false);
    expect('r' in result.points[2]).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Pooled loaders (2026-08-16, trim-bundle plan) — the impure half,
 * driven directly through the exported functions with deferred mocks,
 * the same pattern as the Tier 1 `live-view.test.ts` concurrency test.
 * ------------------------------------------------------------------ */

/** A manually-settled promise. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const RESOLVED_1D = {
  kind: 'intraday' as const,
  multiplier: 5 as const,
  fromMs: Date.parse('2026-08-08T00:00:00Z'),
  toMs: Date.parse('2026-08-16T00:00:00Z'),
  sessions: 1 as const,
};

function candleAt(iso: string, close: string): Candle {
  return { t: Date.parse(iso), open: close, high: close, low: close, close, volume: '1' };
}

const instrument = (id: string, currency = 'USD') => ({
  id,
  symbol: id.toUpperCase(),
  currency,
});

describe('loadIntradayCandles — bounded pool over getAggregates', () => {
  it('caps in-flight at 5, asks each USD instrument exactly once, and never asks PLN/non-USD', async () => {
    // Eight USD instruments up front, then PLN and EUR — the pool parks all
    // five workers on USD fetches before ever reaching the free entries.
    const usd = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'].map((id) => instrument(id));
    const included = [...usd, instrument('p1', 'PLN'), instrument('e1', 'EUR')];

    const gates = new Map(usd.map((i) => [i.symbol, deferred<Candle[]>()]));
    const candlesFor = new Map(
      usd.map((i) => [i.symbol, [candleAt('2026-08-14T14:00:00Z', `${i.id.length}`)]]),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const getAggregates = vi.mocked(massiveProvider.getAggregates);
    getAggregates.mockReset();
    getAggregates.mockImplementation(async (symbol) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const bars = await (gates.get(symbol) as ReturnType<typeof deferred<Candle[]>>).promise;
      inFlight--;
      return bars;
    });

    const resultPromise = loadIntradayCandles(included, RESOLVED_1D);
    await tick();
    // Exactly the pool width is in flight; item 6+ has not started.
    expect(getAggregates).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(5);

    // Releasing one admits exactly one more.
    gates.get('U1')?.resolve(candlesFor.get('U1') as Candle[]);
    await tick();
    expect(getAggregates).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBe(5);

    for (const [symbol, gate] of gates) gate.resolve(candlesFor.get(symbol) as Candle[]);
    const result = await resultPromise;

    // The bound held for the whole run.
    expect(maxInFlight).toBe(5);
    // Each USD instrument asked exactly once — 8 calls total, none for PLN/EUR.
    expect(getAggregates).toHaveBeenCalledTimes(8);
    expect(getAggregates.mock.calls.map(([symbol]) => symbol).sort()).toEqual(
      usd.map((i) => i.symbol).sort(),
    );
    // Keys in input order, values exactly the sequential expectation: each
    // USD instrument's own bars, `[]` for PLN and non-USD.
    expect([...result.keys()]).toEqual(included.map((i) => i.id));
    for (const i of usd) expect(result.get(i.id)).toEqual(candlesFor.get(i.symbol));
    expect(result.get('p1')).toEqual([]);
    expect(result.get('e1')).toEqual([]);
  });

  it("one instrument's rejection degrades to [] — every other entry intact, nothing throws", async () => {
    const included = [instrument('u1'), instrument('u2'), instrument('u3')];
    const good = [candleAt('2026-08-14T14:00:00Z', '100')];
    const getAggregates = vi.mocked(massiveProvider.getAggregates);
    getAggregates.mockReset();
    getAggregates.mockImplementation(async (symbol) => {
      if (symbol === 'U2') throw new Error('vendor 500');
      return good;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadIntradayCandles(included, RESOLVED_1D);

    expect(result.get('u1')).toEqual(good);
    expect(result.get('u2')).toEqual([]);
    expect(result.get('u3')).toEqual(good);
    expect([...result.keys()]).toEqual(['u1', 'u2', 'u3']);
    errorSpy.mockRestore();
  });
});

describe('loadDailyClosesByInstrument — pooled read-through with the backfill bound', () => {
  it('backfills exactly the first MAX_BACKFILL_SYMBOLS ORIGINAL indices, keyed and ordered like the loop', async () => {
    // Two past the bound (mocked at 12), so indices 12 and 13 read cache-only.
    const list = Array.from({ length: 14 }, (_, i) => instrument(`d${i}`));
    const window = { from: '2026-07-16', to: '2026-08-16' };
    const closesFor = new Map(
      list.map((i) => [i.id, new Map([['2026-08-14', `${i.id}-close`]])]),
    );
    const getDailyClosesMock = vi.mocked(getDailyCloses);
    getDailyClosesMock.mockReset();
    getDailyClosesMock.mockImplementation(async (inst) => closesFor.get(inst.id) as Map<string, string>);

    const result = await loadDailyClosesByInstrument(list, window);

    // Every instrument asked exactly once, with the shared window.
    expect(getDailyClosesMock).toHaveBeenCalledTimes(14);
    // The backfill flag follows the ORIGINAL index — true under the bound,
    // false past it — regardless of the pool's settle order.
    for (const [inst, calledWindow, opts] of getDailyClosesMock.mock.calls) {
      const index = list.findIndex((i) => i.id === inst.id);
      expect(calledWindow).toEqual(window);
      expect(opts).toEqual({ backfill: index < MAX_BACKFILL_SYMBOLS });
    }
    // Results keyed in input order with each instrument's own map.
    expect([...result.keys()]).toEqual(list.map((i) => i.id));
    for (const i of list) expect(result.get(i.id)).toBe(closesFor.get(i.id));
  });
});

/* ------------------------------------------------------------------ *
 * Forming-day overlay on daily series (2026-08-29). In-memory only —
 * getDailyBars / getDailyCloses stay completed-session.
 * ------------------------------------------------------------------ */

/** Wednesday 2026-08-12, 12:00 ET — inside the regular session. */
const OVERLAY_NOW = Date.parse('2026-08-12T16:00:00Z');
const OVERLAY_TODAY = '2026-08-12';
const OVERLAY_YESTERDAY = '2026-08-11';

function liveQuote(symbol: string, price: string): Quote {
  return {
    symbol,
    price,
    prevClose: '100',
    asOf: new Date(OVERLAY_NOW),
    asOfSource: 'trade',
    delaySeconds: 900,
    marketStatus: 'open',
    dayChangeAmt: '5.5',
    dayChangePct: '5.5',
    dayOpen: '104',
    dayHigh: '106',
    dayLow: '103',
    dayVolume: 1,
    vwap: price,
    extendedChangeAmt: null,
    extendedChangePct: null,
    extendedKind: null,
    extendedEndedAtMs: null,
    extendedLive: false,
    source: 'massive',
  };
}

describe('forming-day overlay on daily series', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(OVERLAY_NOW);
    h.txRows = [];
    vi.mocked(massiveProvider.getCalendarOverrides).mockResolvedValue([]);
    vi.mocked(massiveProvider.getQuotes).mockReset();
    vi.mocked(massiveProvider.getAggregates).mockReset();
    vi.mocked(getDailyBars).mockReset();
    vi.mocked(getDailyCloses).mockReset();
    vi.mocked(getFxRatesForRange).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends the live last onto a ticker daily series that stops at yesterday', async () => {
    vi.mocked(getDailyBars).mockResolvedValue(
      new Map([
        [OVERLAY_YESTERDAY, { close: '100', open: '99', high: '101', low: '98' }],
      ]),
    );
    vi.mocked(massiveProvider.getQuotes).mockResolvedValue(
      new Map([['AAPL', { ok: true, quote: liveQuote('AAPL', '105.50') }]]),
    );
    vi.mocked(massiveProvider.getAggregates).mockResolvedValue([
      {
        t: Date.parse(`${OVERLAY_TODAY}T12:00:00Z`),
        open: '104.00000000',
        high: '106.10',
        low: '103.25',
        close: '999',
        volume: '1',
      },
    ]);

    const result = await getInstrumentPriceSeries(
      { id: 'ov-aapl', symbol: 'AAPL', currency: 'USD' },
      '2026-01-01',
      '1M',
    );

    const last = result.points[result.points.length - 1];
    expect(last.v).toBe('105.5');
    expect(typeof last.v).toBe('string');
    expect(last.t).toBe(Date.parse(`${OVERLAY_TODAY}T00:00:00Z`));
    // Candle close is ignored — v is the quote last. Wicks come from the bar.
    expect(last.o).toBe('104');
    expect(last.h).toBe('106.1');
    expect(last.l).toBe('103.25');
    expect(result.points.filter((p) => p.t === last.t)).toHaveLength(1);
  });

  it('does not duplicate today when stored bars already include it', async () => {
    vi.mocked(getDailyBars).mockResolvedValue(
      new Map([
        [OVERLAY_YESTERDAY, { close: '100', open: '99', high: '101', low: '98' }],
        [OVERLAY_TODAY, { close: '101.25', open: '101', high: '102', low: '100' }],
      ]),
    );
    vi.mocked(massiveProvider.getQuotes).mockResolvedValue(
      new Map([['AAPL', { ok: true, quote: liveQuote('AAPL', '105.50') }]]),
    );

    const result = await getInstrumentPriceSeries(
      { id: 'ov-aapl-stored', symbol: 'AAPL', currency: 'USD' },
      '2026-01-01',
      '1M',
    );

    const todayPoints = result.points.filter((p) => p.t === Date.parse(`${OVERLAY_TODAY}T00:00:00Z`));
    expect(todayPoints).toHaveLength(1);
    expect(todayPoints[0].v).toBe('101.25');
    expect(massiveProvider.getQuotes).not.toHaveBeenCalled();
  });

  it('does not consult overlay helpers on the 1D/5D path', async () => {
    const overlaySpy = vi.spyOn(formingDay, 'shouldOverlayFormingDay');
    vi.mocked(massiveProvider.getAggregates).mockResolvedValue([
      {
        t: Date.parse('2026-08-12T14:00:00Z'),
        open: '100',
        high: '101',
        low: '99',
        close: '100.5',
        volume: '1',
      },
    ]);

    await getInstrumentPriceSeries(
      { id: 'ov-aapl-1d', symbol: 'AAPL', currency: 'USD' },
      '2026-01-01',
      '1D',
    );

    expect(overlaySpy).not.toHaveBeenCalled();
    expect(massiveProvider.getQuotes).not.toHaveBeenCalled();
    expect(
      vi.mocked(massiveProvider.getAggregates).mock.calls.every(([, spec]) => spec.timespan !== 'day'),
    ).toBe(true);
    overlaySpy.mockRestore();
  });

  it('does not overlay a live last onto an empty stored history', async () => {
    vi.mocked(getDailyBars).mockResolvedValue(new Map());
    vi.mocked(massiveProvider.getQuotes).mockResolvedValue(
      new Map([['AAPL', { ok: true, quote: liveQuote('AAPL', '105.50') }]]),
    );

    const result = await getInstrumentPriceSeries(
      { id: 'ov-aapl-empty', symbol: 'AAPL', currency: 'USD' },
      '2026-01-01',
      '1M',
    );

    expect(result.points).toEqual([]);
    expect(result.excludedSymbols).toEqual(['AAPL']);
    expect(massiveProvider.getQuotes).not.toHaveBeenCalled();
  });

  it('patches today onto portfolio closes without mutating the stored map', async () => {
    const stored = new Map([[OVERLAY_YESTERDAY, '100']]);
    h.txRows = [
      {
        id: 'tx-ov-1',
        instrumentId: 'ov-port-aapl',
        symbol: 'AAPL',
        displayName: 'Apple',
        currency: 'USD',
        side: 'buy',
        quantity: '10',
        price: '100',
        fees: '0',
        fxRateToBase: '4',
        tradeDate: '2026-08-03',
        createdAt: new Date('2026-08-03T12:00:00Z'),
      },
    ];
    vi.mocked(getDailyCloses).mockResolvedValue(stored);
    vi.mocked(getFxRatesForRange).mockResolvedValue(
      new Map([
        [OVERLAY_YESTERDAY, '4'],
        [OVERLAY_TODAY, '4'],
      ]),
    );
    vi.mocked(massiveProvider.getQuotes).mockResolvedValue(
      new Map([['AAPL', { ok: true, quote: liveQuote('AAPL', '105') }]]),
    );

    const result = await getPortfolioValueSeries('user-overlay-1', '1M');

    expect(stored.has(OVERLAY_TODAY)).toBe(false);
    const last = result.points[result.points.length - 1];
    expect(last.t).toBe(Date.parse(`${OVERLAY_TODAY}T00:00:00Z`));
    // 10 × 105 × 4 = 4200.
    expect(last.v).toBe('4200');
    expect(typeof last.v).toBe('string');
  });
});
