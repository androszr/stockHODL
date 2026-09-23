import type { Quote } from './provider';

/**
 * The options market-data contract — types only, deliberately isomorphic like
 * `provider.ts`: no `server-only`, no env, no fetch, so unit tests and the
 * pure mapping/payload code can import it freely.
 *
 * WHY THIS SITS BESIDE `QuoteProvider` INSTEAD OF INSIDE IT: `provider.ts`
 * carries an unrelated in-flight change (the one-session-intraday work,
 * 2026-08-14) and is frozen for this plan; and the NBP precedent
 * (docs/context.md, FX rates) already establishes that a domain outside the
 * equity quotes/candles/search contract honours the server-mediation rule the
 * same way without widening `QuoteProvider`. The vendor fetch lives in
 * `massive.ts` (additive exports), the payload mapping in
 * `massive-mapping.ts` — exactly the equity split.
 *
 * Money discipline: every greek, strike, price and IV here is a **decimal
 * string** produced by the sanctioned JSON-number→`dec()` crossing in
 * `massive-mapping.ts`. `openInterest` is an integer COUNT (never money math)
 * and stays a plain number. An absent figure is `null`, never `'0'` — thinly
 * traded contracts legitimately have no greeks and no IV.
 */

export interface OptionGreeks {
  delta: string | null;
  gamma: string | null;
  theta: string | null;
  vega: string | null;
}

export interface OptionQuote {
  /** OCC-form vendor ticker, e.g. `O:AAPL260904C00220000`. */
  ticker: string;
  /** Underlying stock symbol; null when the payload omitted it. */
  underlying: string | null;
  /**
   * Decimal string, per share. Always `session.close` — verified live
   * 2026-08-14: option snapshots on this tier carry no `session.price` and
   * no trades/quotes, so the close IS the headline at every market status.
   */
  price: string;
  prevClose: string | null;
  /** Atomic day pair derived prevClose → price — both or neither. */
  dayChangeAmt: string | null;
  dayChangePct: string | null;
  marketStatus: Quote['marketStatus'];
  greeks: OptionGreeks;
  impliedVolatility: string | null;
  /** An integer count, never money math. */
  openInterest: number | null;
  contractType: 'call' | 'put';
  strikePrice: string;
  /** 'YYYY-MM-DD'. */
  expirationDate: string;
  sharesPerContract: string;
  asOf: Date;
  /** Always `'fetch'`: option payloads carry no vendor trade timestamp. */
  asOfSource: 'fetch';
  delaySeconds: number;
  source: string;
}

/** Per-ticker result — the `QuoteOutcome` shape, options edition. */
export type OptionQuoteOutcome =
  | { ok: true; quote: OptionQuote }
  | {
      ok: false;
      symbol: string;
      reason: 'not_found' | 'unsupported' | 'error';
      message?: string;
    };

/** One available expiration date for an underlying. */
export interface OptionExpiry {
  /** 'YYYY-MM-DD'. */
  date: string;
}

/** One listed contract, as the reference endpoint describes it. */
export interface OptionContractRef {
  /** OCC-form vendor ticker. */
  ticker: string;
  underlying: string;
  contractType: 'call' | 'put';
  /** Decimal string via the sanctioned boundary. */
  strikePrice: string;
  /** 'YYYY-MM-DD'. */
  expirationDate: string;
  /** Decimal string — a quantity, not an integer. */
  sharesPerContract: string;
}
