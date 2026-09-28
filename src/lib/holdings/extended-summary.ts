import type Decimal from 'decimal.js';

import { dec, pctChange, ZERO } from '@/lib/money';
import type { Position } from '@/lib/position-engine';

import type { HoldingQuote } from './live-payload';

/**
 * The whole book's move at extended-hours prices — the figure behind the
 * Dashboard's "Pre-market · holdings" box and the widgets' "Pre"/"AH" label
 * (plans/2026-09-28-watchlist-grid-extended-hours.md). Pure and isomorphic
 * like `summary.ts`: no `server-only`, no db, no fetch; Decimal in and Decimal
 * out via `money.ts`, formatted by the caller (`composeSlice`).
 *
 * It is computed HERE, server-side, because the phone never re-adds across
 * currencies: the sum needs each quote's FX rate, which only the server holds.
 *
 * The rules, each pinned by `extended-summary.test.ts`:
 *
 * - A position contributes iff it holds shares, its quote is in its own
 *   currency, a rate exists ('1' for PLN), and the quote carries a LIVE
 *   extended reading with a per-share amount. `extendedLive` is the gate —
 *   never `extendedKind !== null`: while the market is closed a quote still
 *   carries the last completed session's reading, and aggregating that would
 *   show a finished session as live (the widget saying "AH" at midnight).
 *   That same gate is what makes the box vanish at 09:30 and 20:00.
 * - The value at extended prices is the REGULAR total plus the move. Holdings
 *   with no extended trade therefore count at their last price, and a row the
 *   regular summary excluded (no FX) can never silently re-enter — do not
 *   re-sum per position.
 * - Null when nothing contributed or the regular total is null: there is no
 *   extended figure to state.
 */

/** The quote fields the aggregate reads — `HoldingQuote` satisfies it. */
export type ExtendedQuote = Pick<
  HoldingQuote,
  'currency' | 'extendedChangeAmt' | 'extendedChangePct' | 'extendedKind' | 'extendedLive'
>;

/** The position fields the aggregate reads — `Position` satisfies it. */
export type ExtendedPosition = Pick<Position, 'symbol' | 'currency' | 'quantity'>;

export interface ExtendedMoverResult {
  symbol: string;
  /** The per-share extended percent; null when the quote carried none. */
  pctDec: Decimal | null;
  /** The per-share extended amount — its sign is the mover's direction. */
  amtDec: Decimal;
  /** quantity × amount × rate — the ordering key. */
  impactPLN: Decimal;
}

export interface ExtendedSummaryResult {
  kind: 'early' | 'late';
  /** Σ quantity × extendedChangeAmt × rate over contributing positions. */
  movePLN: Decimal;
  /** The move against the regular total; null on a zero base. */
  movePct: Decimal | null;
  /** Regular total + move. */
  valueAtExtendedPLN: Decimal;
  /** Positions that contributed a live extended reading. */
  pricedCount: number;
  /** Positions holding shares (quantity > 0), priced or not. */
  holdingsCount: number;
  /** Largest |impact| first, ties by symbol ascending, at most three. */
  movers: ExtendedMoverResult[];
}

/** How many mover chips the box and the payload carry. */
export const MAX_EXTENDED_MOVERS = 3;

export function computeExtendedSummary(
  positions: readonly ExtendedPosition[],
  quotes: ReadonlyMap<string, ExtendedQuote>,
  fxRates: ReadonlyMap<string, string>,
  regularTotalPLN: Decimal | null,
): ExtendedSummaryResult | null {
  let holdingsCount = 0;
  let kind: 'early' | 'late' | null = null;
  let movePLN = ZERO;
  const contributors: ExtendedMoverResult[] = [];

  for (const p of positions) {
    if (!p.quantity.greaterThan(0)) continue;
    holdingsCount++;

    const quote = quotes.get(p.symbol);
    // Same wrong-currency guard as the engine and the summary.
    const usable = quote && quote.currency === p.currency ? quote : undefined;
    if (!usable) continue;
    const rate = p.currency === 'PLN' ? '1' : fxRates.get(p.currency);
    if (rate === undefined) continue;
    if (usable.extendedKind === null || usable.extendedLive !== true) continue;
    if (typeof usable.extendedChangeAmt !== 'string') continue;

    const amtDec = dec(usable.extendedChangeAmt);
    const impactPLN = p.quantity.times(amtDec).times(dec(rate));
    movePLN = movePLN.plus(impactPLN);
    kind ??= usable.extendedKind;
    contributors.push({
      symbol: p.symbol,
      pctDec: usable.extendedChangePct === null ? null : dec(usable.extendedChangePct),
      amtDec,
      impactPLN,
    });
  }

  if (contributors.length === 0 || kind === null || regularTotalPLN === null) return null;

  const valueAtExtendedPLN = regularTotalPLN.plus(movePLN);
  const movers = [...contributors]
    .sort((a, b) => {
      const byImpact = b.impactPLN.abs().comparedTo(a.impactPLN.abs());
      if (byImpact !== 0) return byImpact;
      return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
    })
    .slice(0, MAX_EXTENDED_MOVERS);

  return {
    kind,
    movePLN,
    // pctChange refuses a zero base — null, rendered without a percent.
    movePct: pctChange(regularTotalPLN, valueAtExtendedPLN),
    valueAtExtendedPLN,
    pricedCount: contributors.length,
    holdingsCount,
    movers,
  };
}
