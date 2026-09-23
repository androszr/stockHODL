import 'server-only';

import { getCurrentFxRateToPln } from '@/lib/fx/nbp';

import {
  fetchMarketStatusBestEffort,
  fetchQuotesBestEffort,
  type HoldingsSourceRow,
  type LoadedHoldings,
} from './live-view';

/**
 * The NARROW instrument loader (2026-08-16 ticker-page plan): the ticker
 * page's replacement for the whole-portfolio `loadHoldingsInputs` walk. The
 * page already holds this instrument's ownership-scoped rows from its own
 * join — so the vendor batch shrinks to ONE symbol, the NBP pass to ONE
 * currency, and no second DB query runs at all.
 *
 * Verified lossless (the plan's field-by-field walk, pinned by
 * `instrument-view.test.ts`): every figure the ticker page renders is
 * per-instrument by construction — positions fold each instrument's own rows,
 * the day stats and portfolio groups only ever look up THIS symbol and THIS
 * currency. If a future field on that page ever needs portfolio-wide data, it
 * must go back through `loadHoldingsInputs` — never quietly widen this loader.
 *
 * `portfolios` is OMITTED from the returned inputs on purpose: absent → no
 * scopes are composed at all (`live-payload.ts`), which is exactly what the
 * ticker page wants — it never reads `view.scopes`, `view.live.summary` or
 * the portfolio list.
 */

/**
 * Latest published NBP mid per distinct non-PLN currency — a local inline of
 * `live-view.ts`'s private `fetchFxRatesBestEffort` (that file is frozen and
 * does not export its helper): the same never-throw discipline for what is,
 * for an instrument, exactly one currency. Never throws — failures skip the
 * currency (or clear the map wholesale); the figures degrade to cost-only.
 */
async function fetchFxRateBestEffort(currencies: readonly string[]): Promise<Map<string, string>> {
  const fxRates = new Map<string, string>();
  try {
    for (const currency of currencies) {
      const result = await getCurrentFxRateToPln(currency);
      if (result.ok) fxRates.set(currency, result.rate);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'fx lookup failed';
    console.error(`Instrument FX lookup failed: ${message}`);
    fxRates.clear();
  }
  return fxRates;
}

/**
 * Build a `LoadedHoldings` for ONE instrument from its already-fetched rows:
 * quote + FX rate + market status, in parallel. The symbol/currency sets are
 * derived generically from the rows (one instrument → one of each, but the
 * derivation matches `loadHoldingsInputs` verbatim so the equivalence is
 * structural, not accidental). The refs opt the quote into the durable cache
 * — the same discipline as the full walk and the watched branch.
 *
 * `Promise.all` is safe here ONLY because every member is a documented
 * never-throw best-effort function (each degrades to an empty map or a
 * clock-derived status internally). A future member that can throw would
 * break the whole-payload degradation contract — cost-only figures, "—",
 * derived market status — by turning one leg's failure into a whole-page
 * failure. Keep that invariant, or switch to allSettled. (The doctrine is
 * `live-view.ts`'s, restated because this file must uphold it independently.)
 */
export async function loadInstrumentInputs(
  rows: readonly HoldingsSourceRow[],
): Promise<LoadedHoldings> {
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const refs = new Map(rows.map((r) => [r.symbol, r.instrumentId]));
  const currencies = [...new Set(rows.map((r) => r.currency))].filter((c) => c !== 'PLN');

  const [{ quotes, pollable, cached }, fxRates, market] = await Promise.all([
    fetchQuotesBestEffort(symbols, refs),
    fetchFxRateBestEffort(currencies),
    fetchMarketStatusBestEffort(),
  ]);

  return {
    rows: [...rows],
    inputs: {
      engineTxs: [...rows],
      fxRates,
      market,
      // Present for shape parity with the full walk, but UNCONSUMED on the
      // ticker page (no live-payload client hook mounts there) — computed
      // over this one symbol instead of the whole portfolio.
      hasPollableSymbols: pollable,
      cachedQuotes: cached,
      // `portfolios` deliberately absent — no scopes composed (see above).
    },
    quotes,
  };
}
