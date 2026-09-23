import { describe, expect, it } from 'vitest';

import type { OptionQuote, OptionQuoteOutcome } from '@/lib/market-data/options-types';
import { dec } from '@/lib/money';

import { markOption, markOptionQuotes, markOptionRecords } from './option-mark';

/**
 * The MARK BOUNDARY under test: decimal strings in, decimal strings out, and
 * a silent per-contract fallback (null) on every gate. The three fixtures are
 * the ones measured live 2026-08-15 — the same ground truth
 * `black-scholes.test.ts` pins, asserted here as the decimal strings the rest
 * of the app actually consumes.
 *
 * `NOW_MS` is 2026-08-15 12:00 ET, so every `T` matches the measured run.
 */

const NOW_MS = Date.UTC(2026, 7, 15, 16);

function quote(overrides: Partial<OptionQuote> = {}): OptionQuote {
  return {
    ticker: 'O:ACME270319C00260000',
    underlying: 'ACME',
    price: '12.10',
    prevClose: '13.07',
    dayChangeAmt: null,
    dayChangePct: null,
    marketStatus: 'closed',
    greeks: {
      delta: '0.2777239463315493',
      gamma: null,
      theta: null,
      vega: null,
    },
    impliedVolatility: '0.4570918869866558',
    openInterest: 100,
    contractType: 'call',
    strikePrice: '260',
    expirationDate: '2027-03-19',
    sharesPerContract: '100',
    asOf: new Date(NOW_MS),
    asOfSource: 'fetch',
    delaySeconds: 900,
    source: 'massive',
    ...overrides,
  };
}

const ACME = quote();

const ZORA = quote({
  ticker: 'O:ZORA270319C00095000',
  underlying: 'ZORA',
  strikePrice: '95',
  impliedVolatility: '0.4118177042206123',
  greeks: { delta: '0.2600334521307547', gamma: null, theta: null, vega: null },
});

const IDXF = quote({
  ticker: 'O:IDXF261218C00700000',
  underlying: 'IDXF',
  strikePrice: '700',
  expirationDate: '2026-12-18',
  impliedVolatility: '0.21741383434743794',
  greeks: { delta: '0.8258135982294877', gamma: null, theta: null, vega: null },
});

const SPOTS = new Map([
  ['ACME', '196.21'],
  ['ZORA', '73.79'],
  ['IDXF', '776.34'],
]);

/** Two-decimal view of a decimal string — the figure a card would render. */
function at2(value: string | null): string | null {
  return value === null ? null : dec(value).toFixed(2);
}

describe('the golden fixtures cross the boundary as decimal strings', () => {
  it('ACME marks at 9.99 — the reference mid is 9.97, the last trade was 12.10', () => {
    expect(at2(markOption(ACME, '196.21', NOW_MS))).toBe('9.99');
  });

  it('ZORA marks at 3.16 instead of a 3.90 fill', () => {
    expect(at2(markOption(ZORA, '73.79', NOW_MS))).toBe('3.16');
  });

  it('IDXF, the liquid control, marks at 91.54 against a real last trade of 92.73', () => {
    expect(at2(markOption(IDXF, '776.34', NOW_MS))).toBe('91.54');
  });

  it('records the inputs beside the mark so a stored mark can be audited', () => {
    const records = markOptionRecords(
      new Map<string, OptionQuoteOutcome>([[ACME.ticker, { ok: true, quote: ACME }]]),
      SPOTS,
      NOW_MS,
    );
    const record = records.get(ACME.ticker);
    expect(record?.underlyingPrice).toBe('196.21');
    expect(record?.impliedVolatility).toBe('0.4570918869866558');
    expect(record?.delta).toBe('0.2777239463315493');
    expect(dec(record?.rate ?? '0').toFixed(4)).toBe('0.0209');
  });

  it('refuses to mark when the vendor disagrees with OUR stored underlying', () => {
    // Security-review hardening: the spot is chosen purely on the vendor's
    // `underlying_asset.ticker`. If that were ever wrong and the other symbol
    // happened to be in the same batch, the contract would be priced off a
    // different company's share price — and then recorded permanently. No
    // mark is safer than a confident wrong one; the contract simply falls
    // back to its traded price.
    const quotes = new Map<string, OptionQuoteOutcome>([
      [ACME.ticker, { ok: true, quote: ACME }],
    ]);
    const mismatched = markOptionRecords(
      quotes,
      SPOTS,
      NOW_MS,
      new Map([[ACME.ticker, 'ZORA']]), // we stored ZORA; the vendor says ACME
    );
    expect(mismatched.has(ACME.ticker)).toBe(false);

    // Agreement (case-insensitively) still marks, so the guard cannot quietly
    // switch the whole feature off.
    const agreed = markOptionRecords(
      quotes,
      SPOTS,
      NOW_MS,
      new Map([[ACME.ticker, 'acme']]),
    );
    expect(agreed.get(ACME.ticker)?.mark).toBeDefined();
  });
});

describe('every gate is a silent per-contract fallback (null), never a guess', () => {
  it('no implied volatility → null (thin contracts omit the field entirely)', () => {
    expect(markOption(quote({ impliedVolatility: null }), '196.21', NOW_MS)).toBeNull();
  });

  it('implied volatility of zero → null', () => {
    expect(markOption(quote({ impliedVolatility: '0' }), '196.21', NOW_MS)).toBeNull();
  });

  it('empty greeks → null (`greeks: {}` maps every greek to null)', () => {
    const bare = quote({ greeks: { delta: null, gamma: null, theta: null, vega: null } });
    expect(markOption(bare, '196.21', NOW_MS)).toBeNull();
  });

  it('a call delta at the bounds → null — the rate recovery is unsolvable there', () => {
    for (const delta of ['0', '1', '-0.3']) {
      const edge = quote({ greeks: { delta, gamma: null, theta: null, vega: null } });
      expect(markOption(edge, '196.21', NOW_MS)).toBeNull();
    }
  });

  it('an EXPIRED contract → null: intrinsic value is the only honest answer', () => {
    expect(markOption(quote({ expirationDate: '2026-08-14' }), '196.21', NOW_MS)).toBeNull();
  });

  it('a SAME-DAY expiry → null: T = 0 is where the model degenerates', () => {
    expect(markOption(quote({ expirationDate: '2026-08-15' }), '196.21', NOW_MS)).toBeNull();
  });

  it('no underlying spot in the batch → null', () => {
    expect(markOption(ACME, undefined, NOW_MS)).toBeNull();
  });

  it('a spot of zero → null', () => {
    expect(markOption(ACME, '0', NOW_MS)).toBeNull();
  });

  it('a mark below intrinsic value → null (arbitrage-free nonsense)', () => {
    // Deep ITM with a near-1 delta: the recovered rate is strongly negative
    // and the discounted strike alone pushes the price under S − K.
    const deepItm = quote({
      strikePrice: '100',
      expirationDate: '2027-08-15',
      impliedVolatility: '0.1',
      greeks: { delta: '0.99', gamma: null, theta: null, vega: null },
    });
    expect(markOption(deepItm, '200', NOW_MS)).toBeNull();
  });

  it('a put mark above its strike → null (the standard upper bound)', () => {
    // A long-dated, deep-ITM put whose recovered rate is strongly negative:
    // the model prices it at ~488 on a strike of 100, which no put can be
    // worth. It converges — and is still rejected.
    const absurd = quote({
      contractType: 'put',
      strikePrice: '100',
      expirationDate: '2030-08-15',
      impliedVolatility: '0.5',
      greeks: { delta: '-0.9999', gamma: null, theta: null, vega: null },
    });
    expect(markOption(absurd, '7.27', NOW_MS)).toBeNull();
  });

  it('a plausible PUT prices and stays inside its own bounds', () => {
    const put = quote({
      ticker: 'O:ACME270319P00180000',
      contractType: 'put',
      strikePrice: '180',
      impliedVolatility: '0.42',
      greeks: { delta: '-0.35', gamma: null, theta: null, vega: null },
    });
    const mark = markOption(put, '196.21', NOW_MS);
    expect(mark).not.toBeNull();
    const value = dec(mark as string);
    expect(value.greaterThan(0)).toBe(true);
    expect(value.lessThanOrEqualTo(dec('180'))).toBe(true);
  });
});

describe('markOptionQuotes over a batch', () => {
  const quotes = new Map<string, OptionQuoteOutcome>([
    [ACME.ticker, { ok: true, quote: ACME }],
    [ZORA.ticker, { ok: true, quote: ZORA }],
    ['O:XYZ270319C00010000', { ok: false, symbol: 'O:XYZ270319C00010000', reason: 'not_found' }],
  ]);

  it('returns one decimal string per markable contract and skips failed outcomes', () => {
    const marks = markOptionQuotes(quotes, SPOTS, NOW_MS);
    expect(marks.size).toBe(2);
    expect(at2(marks.get(ACME.ticker) ?? null)).toBe('9.99');
    expect(at2(marks.get(ZORA.ticker) ?? null)).toBe('3.16');
    expect(marks.has('O:XYZ270319C00010000')).toBe(false);
  });

  it('skips a contract whose underlying did not arrive in the batch', () => {
    const marks = markOptionQuotes(quotes, new Map([['ACME', '196.21']]), NOW_MS);
    expect(marks.has(ACME.ticker)).toBe(true);
    expect(marks.has(ZORA.ticker)).toBe(false);
  });

  it('resolves the spot case-insensitively — vendor tickers come back uppercase', () => {
    const marks = markOptionQuotes(
      new Map<string, OptionQuoteOutcome>([
        [ACME.ticker, { ok: true, quote: { ...ACME, underlying: 'acme' } }],
      ]),
      SPOTS,
      NOW_MS,
    );
    expect(at2(marks.get(ACME.ticker) ?? null)).toBe('9.99');
  });

  it('skips a quote with no underlying symbol at all', () => {
    const marks = markOptionQuotes(
      new Map<string, OptionQuoteOutcome>([
        [ACME.ticker, { ok: true, quote: { ...ACME, underlying: null } }],
      ]),
      SPOTS,
      NOW_MS,
    );
    expect(marks.size).toBe(0);
  });
});
