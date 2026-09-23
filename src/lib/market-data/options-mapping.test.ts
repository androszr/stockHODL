import { describe, expect, it } from 'vitest';

import {
  deriveDayPair,
  mapOptionContracts,
  mapOptionSnapshotResult,
  mapUnderlyingSpot,
  mixedSnapshotResultSchema,
  nextExpirationQueryDate,
  optionContractsParams,
  optionSnapshotResultSchema,
} from './massive-mapping';

/**
 * Unit tests for the option snapshot / contracts mappers — a separate file
 * so `massive-mapping.test.ts` stays merge-clean against the unrelated
 * in-flight equity work. Fixtures mirror the payloads verified live
 * 2026-08-14 against our own key: `type: "options"`, no
 * `last_trade`/`last_quote` on this tier (price IS `session.close`),
 * `greeks: {}` and a MISSING `implied_volatility` key on illiquid
 * contracts.
 */

const TICKER = 'O:AAPL260904C00220000';

const CTX = {
  delaySeconds: 900,
  source: 'massive',
  now: new Date('2026-08-14T12:00:00Z'),
};

/** The verified full option snapshot result, as JSON.parse would yield it. */
function fullResult(overrides: Record<string, unknown> = {}) {
  return {
    ticker: TICKER,
    type: 'options',
    market_status: 'closed',
    name: 'AAPL Sep 4 2026 220 Call',
    session: {
      open: 24.5,
      high: 25.1,
      low: 24.0,
      close: 24.8,
      previous_close: 24.2,
      change: 0.6,
      change_percent: 2.47,
      volume: 132,
      early_trading_change: 0.1,
      early_trading_change_percent: 0.41,
    },
    details: {
      contract_type: 'call',
      strike_price: 220,
      expiration_date: '2026-09-04',
      exercise_style: 'american',
      shares_per_contract: 100,
    },
    greeks: { delta: 0.6421, gamma: 0.0112, theta: -0.0521, vega: 0.2201 },
    implied_volatility: 0.2932,
    open_interest: 15234,
    underlying_asset: { ticker: 'AAPL' },
    ...overrides,
  };
}

function map(raw: Record<string, unknown>) {
  return mapOptionSnapshotResult(optionSnapshotResultSchema.parse(raw), CTX);
}

describe('mapOptionSnapshotResult', () => {
  it('maps the full verified payload completely', () => {
    const outcome = map(fullResult());
    expect(outcome).not.toBeNull();
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    const q = outcome.quote;
    expect(q.ticker).toBe(TICKER);
    expect(q.underlying).toBe('AAPL');
    expect(q.price).toBe('24.8'); // session.close, always — no session.price exists
    expect(q.prevClose).toBe('24.2');
    expect(q.marketStatus).toBe('closed');
    expect(q.contractType).toBe('call');
    expect(q.strikePrice).toBe('220');
    expect(q.expirationDate).toBe('2026-09-04');
    expect(q.sharesPerContract).toBe('100');
    expect(q.greeks).toEqual({
      delta: '0.6421',
      gamma: '0.0112',
      theta: '-0.0521',
      vega: '0.2201',
    });
    expect(q.impliedVolatility).toBe('0.2932');
    expect(q.openInterest).toBe(15234);
    expect(q.asOfSource).toBe('fetch');
    expect(q.asOf).toBe(CTX.now);
    expect(q.delaySeconds).toBe(900);
    expect(q.source).toBe('massive');
  });

  it('maps an empty greeks object to four nulls — never zeros', () => {
    const outcome = map(fullResult({ greeks: {} }));
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.greeks).toEqual({
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
    });
  });

  it('maps a missing implied_volatility to null, never the string 0', () => {
    const raw = fullResult();
    delete (raw as Record<string, unknown>).implied_volatility;
    const outcome = map(raw);
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.impliedVolatility).toBeNull();
    expect(outcome.quote.impliedVolatility).not.toBe('0');
  });

  it('degrades a missing session.close to an error outcome', () => {
    const raw = fullResult();
    (raw.session as Record<string, unknown>).close = undefined;
    const outcome = map(raw);
    expect(outcome).toEqual({
      ok: false,
      symbol: TICKER,
      reason: 'error',
      message: 'no usable price field',
    });
  });

  it('nulls BOTH day-pair halves when previous_close is absent', () => {
    const raw = fullResult();
    delete (raw.session as Record<string, unknown>).previous_close;
    const outcome = map(raw);
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.prevClose).toBeNull();
    expect(outcome.quote.dayChangeAmt).toBeNull();
    expect(outcome.quote.dayChangePct).toBeNull();
  });

  it('derives the day pair exactly as deriveDayPair on the verified numbers', () => {
    const outcome = map(fullResult());
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    const expected = deriveDayPair(24.2, 24.8);
    expect(expected).not.toBeNull();
    expect(outcome.quote.dayChangeAmt).toBe(expected?.amt);
    expect(outcome.quote.dayChangePct).toBe(expected?.pct);
    // The atomic pair on exact Decimal math: 24.8 − 24.2 is 0.6, no float dust.
    expect(outcome.quote.dayChangeAmt).toBe('0.6');
  });

  it('rejects a non-options type as unsupported', () => {
    const outcome = map(fullResult({ type: 'stocks' }));
    expect(outcome).toEqual({
      ok: false,
      symbol: TICKER,
      reason: 'unsupported',
      message: 'type=stocks',
    });
  });

  it('maps a per-result error inside a 200 to an error outcome', () => {
    const outcome = map({
      ticker: TICKER,
      error: 'NOT_ENTITLED',
      message: 'not entitled to this ticker',
    });
    expect(outcome).toEqual({
      ok: false,
      symbol: TICKER,
      reason: 'error',
      message: 'not entitled to this ticker',
    });
  });

  it('returns null for an entry without a ticker (unusable for reconciliation)', () => {
    const raw = fullResult();
    delete (raw as Record<string, unknown>).ticker;
    expect(map(raw)).toBeNull();
  });

  it('passes open_interest through as an integer and maps absence to null', () => {
    const withOi = map(fullResult({ open_interest: 7 }));
    if (!withOi || !withOi.ok) throw new Error('expected ok outcome');
    expect(withOi.quote.openInterest).toBe(7);

    const raw = fullResult();
    delete (raw as Record<string, unknown>).open_interest;
    const withoutOi = map(raw);
    if (!withoutOi || !withoutOi.ok) throw new Error('expected ok outcome');
    expect(withoutOi.quote.openInterest).toBeNull();
  });

  it('degrades incomplete contract details to an error outcome, not a crash', () => {
    const raw = fullResult({ details: { exercise_style: 'american' } });
    const outcome = map(raw);
    expect(outcome).toEqual({
      ok: false,
      symbol: TICKER,
      reason: 'error',
      message: 'incomplete contract details',
    });
  });

  it('defaults a missing shares_per_contract to 100', () => {
    const raw = fullResult();
    delete (raw.details as Record<string, unknown>).shares_per_contract;
    const outcome = map(raw);
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.sharesPerContract).toBe('100');
  });
});

describe('optionContractsParams', () => {
  it('emits only the verified parameter names, fully populated', () => {
    const params = optionContractsParams('AAPL', {
      contractType: 'call',
      expirationDate: '2026-09-04',
      expirationDateGte: '2026-09-05',
      expired: false,
      limit: 1000,
      sort: 'strike_price',
      order: 'asc',
    });
    expect([...params.keys()].sort()).toEqual([
      'contract_type',
      'expiration_date',
      'expiration_date.gte',
      'expired',
      'limit',
      'order',
      'sort',
      'underlying_ticker',
    ]);
    expect(params.get('underlying_ticker')).toBe('AAPL');
    expect(params.get('expired')).toBe('false');
    expect(params.get('limit')).toBe('1000');
  });

  it('emits only the underlying when no filters are given', () => {
    const params = optionContractsParams('BRK.A');
    expect([...params.keys()]).toEqual(['underlying_ticker']);
    expect(params.get('underlying_ticker')).toBe('BRK.A');
  });
});

describe('mapOptionContracts', () => {
  it('drops incomplete rows and emits decimal-string strikes', () => {
    const refs = mapOptionContracts([
      {
        ticker: TICKER,
        underlying_ticker: 'AAPL',
        contract_type: 'call',
        expiration_date: '2026-09-04',
        strike_price: 220,
        shares_per_contract: 100,
      },
      // Each of these is missing one identity field — all dropped.
      { underlying_ticker: 'AAPL', contract_type: 'call', expiration_date: '2026-09-04', strike_price: 220 },
      { ticker: 'O:X260904C00000500', contract_type: 'call', expiration_date: '2026-09-04', strike_price: 5 },
      { ticker: 'O:X260904C00000500', underlying_ticker: 'X', expiration_date: '2026-09-04', strike_price: 5 },
      { ticker: 'O:X260904C00000500', underlying_ticker: 'X', contract_type: 'other', expiration_date: '2026-09-04', strike_price: 5 },
      { ticker: 'O:X260904C00000500', underlying_ticker: 'X', contract_type: 'call', strike_price: 5 },
      { ticker: 'O:X260904C00000500', underlying_ticker: 'X', contract_type: 'call', expiration_date: '2026-09-04' },
    ]);
    expect(refs).toEqual([
      {
        ticker: TICKER,
        underlying: 'AAPL',
        contractType: 'call',
        strikePrice: '220',
        expirationDate: '2026-09-04',
        sharesPerContract: '100',
      },
    ]);
  });

  it('defaults shares_per_contract to 100 and keeps fractional strikes exact', () => {
    const refs = mapOptionContracts([
      {
        ticker: 'O:F260918P00012500',
        underlying_ticker: 'F',
        contract_type: 'put',
        expiration_date: '2026-09-18',
        strike_price: 12.5,
      },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].strikePrice).toBe('12.5');
    expect(refs[0].sharesPerContract).toBe('100');
  });
});

describe('nextExpirationQueryDate', () => {
  it('increments an ordinary day', () => {
    expect(nextExpirationQueryDate('2026-09-04')).toBe('2026-09-05');
  });

  it('crosses a month boundary', () => {
    expect(nextExpirationQueryDate('2026-08-31')).toBe('2026-09-01');
  });

  it('crosses a year boundary', () => {
    expect(nextExpirationQueryDate('2026-12-31')).toBe('2027-01-01');
  });

  it('respects leap years', () => {
    expect(nextExpirationQueryDate('2028-02-28')).toBe('2028-02-29');
    expect(nextExpirationQueryDate('2027-02-28')).toBe('2027-03-01');
  });
});

describe('mapUnderlyingSpot — the underlying rides the same mixed batch', () => {
  /** A stock result as `/v3/snapshot` returns it beside the option results. */
  function stockResult(overrides: Record<string, unknown> = {}) {
    return {
      ticker: 'CRM',
      type: 'stocks',
      market_status: 'closed',
      session: { close: 196.21, price: 197.4, previous_close: 199.05 },
      ...overrides,
    };
  }

  it('picks session.price while the market is OPEN — the coherent live price', () => {
    const spot = mapUnderlyingSpot(
      mixedSnapshotResultSchema.parse(stockResult({ market_status: 'open' })),
    );
    expect(spot).toEqual({ symbol: 'CRM', price: '197.4' });
  });

  it('picks the official session.close outside regular hours', () => {
    const spot = mapUnderlyingSpot(mixedSnapshotResultSchema.parse(stockResult()));
    expect(spot).toEqual({ symbol: 'CRM', price: '196.21' });
  });

  it('returns a decimal string, never a float — the sanctioned crossing', () => {
    const spot = mapUnderlyingSpot(
      mixedSnapshotResultSchema.parse(stockResult({ session: { close: 0.1 + 0.2 } })),
    );
    expect(typeof spot?.price).toBe('string');
    expect(spot?.price).toBe('0.30000000000000004');
  });

  it('skips a per-result error entry', () => {
    const spot = mapUnderlyingSpot(
      mixedSnapshotResultSchema.parse(stockResult({ error: 'NOT_FOUND', message: 'no such' })),
    );
    expect(spot).toBeNull();
  });

  it('skips an OPTION result — those go to mapOptionSnapshotResult', () => {
    const spot = mapUnderlyingSpot(mixedSnapshotResultSchema.parse(fullResult()));
    expect(spot).toBeNull();
  });

  it('skips a result with no usable price and one with no ticker', () => {
    expect(
      mapUnderlyingSpot(mixedSnapshotResultSchema.parse(stockResult({ session: {} }))),
    ).toBeNull();
    expect(
      mapUnderlyingSpot(mixedSnapshotResultSchema.parse(stockResult({ ticker: undefined }))),
    ).toBeNull();
  });
});
