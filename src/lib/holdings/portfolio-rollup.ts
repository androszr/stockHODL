import {
  dec,
  directionOf,
  fmtMoney,
  fmtPct,
  fmtQuantity,
  pctChange,
  type Direction,
} from '@/lib/money';
import {
  computePositions,
  displayablePositions,
  type EngineTransaction,
} from '@/lib/position-engine';

import type { HoldingQuote } from './live-payload';
import { computePortfolioSummary } from './summary';

/**
 * Pure per-portfolio rollup for the `/portfolios` bars — isomorphic like
 * `summary.ts`: no `server-only`, no env, no fetch. The caller (the page's
 * Server Component) groups the shared loader's rows by `portfolioId` and runs
 * this once per group; internally it is the same engine → summary pipeline
 * the Holdings screen runs, so a bar's figure can never disagree with the
 * Holdings math for the same rows.
 *
 * Only pre-formatted display strings (plus `Direction` tokens) leave this
 * function — Decimal never crosses the client boundary. Exclusion semantics
 * follow `summary.ts`: an unpriceable position is NAMED in `excludedSymbols`
 * and contributes nothing, never a silent zero. No day-change figures here —
 * this page shows value + total change vs cost only.
 */

export interface RollupTicker {
  instrumentId: string;
  symbol: string;
  displayName: string;
  /** fmtQuantity output — a display string, never fed back into arithmetic. */
  quantity: string;
  oversold: boolean;
  /** fmtMoney(qty × price × fx, 'PLN'); null per the guard chain. */
  valuePLN: string | null;
  /** fmtPct output — already '—' when the percentage is undefined. */
  changePct: string;
  /** directionOf(unrealizedPLN) — server-computed, never inferred client-side. */
  direction: Direction;
}

export interface PortfolioRollup {
  /** fmtMoney(summary.totalValuePLN, 'PLN'); null when nothing priced. */
  valuePLN: string | null;
  /** fmtPct(totalChangePct) / directionOf(totalChangePLN); null when nothing priced. */
  changePct: { text: string; direction: Direction } | null;
  /** Straight from computePortfolioSummary — named, never zeroed. */
  excludedSymbols: string[];
  tickers: RollupTicker[];
}

export function composePortfolioRollup(
  txs: EngineTransaction[],
  quotes: ReadonlyMap<string, HoldingQuote>,
  fxRates: ReadonlyMap<string, string>,
): PortfolioRollup {
  // Open positions plus oversold-at-zero ones — the oversold badge must stay
  // reachable in exactly the case it exists for (sell entered before its buy).
  const open = displayablePositions(computePositions(txs, quotes, fxRates));

  const summary = computePortfolioSummary(open, quotes, fxRates);

  const tickers: RollupTicker[] = open.map((p) => {
    // The exact `composeLivePayload` conventions: usable quote (currency
    // match), rate present ('1' for PLN), quantity > 0 — so a panel row can
    // never disagree with the bar total it sums into.
    const quote = quotes.get(p.symbol);
    const usable = quote && quote.currency === p.currency ? quote : undefined;
    const rate = usable ? (p.currency === 'PLN' ? '1' : fxRates.get(p.currency)) : undefined;
    const valuePLN =
      usable && rate !== undefined && p.quantity.greaterThan(0)
        ? fmtMoney(p.quantity.times(dec(usable.price)).times(dec(rate)), 'PLN')
        : null;

    // Percent against the PLN cost basis. `pctChange` returns null on a zero
    // basis (oversold-at-zero) and fmtPct renders it "—" — never +0.00%.
    const pct =
      p.unrealizedPLN === null
        ? null
        : pctChange(p.costBasisPLN, p.costBasisPLN.plus(p.unrealizedPLN));

    return {
      instrumentId: p.instrumentId,
      symbol: p.symbol,
      displayName: p.displayName,
      quantity: fmtQuantity(p.quantity),
      oversold: p.oversold,
      valuePLN,
      changePct: fmtPct(pct),
      direction: directionOf(p.unrealizedPLN),
    };
  });

  return {
    valuePLN: summary.totalValuePLN === null ? null : fmtMoney(summary.totalValuePLN, 'PLN'),
    changePct:
      summary.totalChangePLN === null
        ? null
        : {
            text: fmtPct(summary.totalChangePct),
            direction: directionOf(summary.totalChangePLN),
          },
    excludedSymbols: summary.excludedSymbols,
    tickers,
  };
}
