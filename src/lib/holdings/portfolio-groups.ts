import type { HoldingDetailData } from '@/lib/holdings/types';
import { dec, directionOf, fmtMoney, fmtPct, fmtQuantity, pctChange } from '@/lib/money';
import { computePositions, type EngineTransaction } from '@/lib/position-engine';

import { signedMoney, type HoldingQuote } from './live-payload';

/**
 * Per-portfolio position summaries for the instrument page — pure and
 * isomorphic like `live-payload.ts`: no `server-only`, no DB, no fetch.
 * Decimal in via `money.ts`, pre-formatted strings out.
 *
 * Each portfolio's figures come from running the SAME position engine over
 * that portfolio's rows alone — never from pre-summed arithmetic and never
 * from slicing the combined position. Average cost with interleaved sells is
 * order-dependent and per-portfolio bookkeeping legitimately differs from a
 * proportional share of the combined card (each portfolio realizes against
 * its own running average); shares, however, always sum exactly.
 */

/** One joined transaction row plus the portfolio dimension for grouping. */
export interface PortfolioGroupRow extends EngineTransaction {
  portfolioId: string;
  portfolioName: string;
  portfolioSortOrder: number;
  portfolioCreatedAt: Date;
}

export interface PortfolioGroup {
  portfolioId: string;
  portfolioName: string;
  /** Pre-formatted, `HoldingDetailData`-shaped six-cell figure set. */
  summary: HoldingDetailData;
}

/**
 * Partition one instrument's rows by portfolio and run the position engine
 * over each partition. Every portfolio with rows yields a group —
 * `displayablePositions` is deliberately NOT applied: a fully-sold portfolio
 * still has transactions to show, with Shares "0" and dashes for the figures
 * that no longer apply (never a fake valued zero).
 *
 * Ordering mirrors the Portfolios screen exactly (`sortOrder` asc,
 * `createdAt` asc, then name asc for a total, testable order) — named
 * containers the user arranged deliberately; a price move must not reshuffle
 * them between visits.
 */
export function computePortfolioGroups(
  rows: PortfolioGroupRow[],
  quotes: ReadonlyMap<string, HoldingQuote>,
  fxRates: ReadonlyMap<string, string>,
): PortfolioGroup[] {
  const partitions = new Map<string, PortfolioGroupRow[]>();
  for (const row of rows) {
    const partition = partitions.get(row.portfolioId);
    if (partition) {
      partition.push(row);
    } else {
      partitions.set(row.portfolioId, [row]);
    }
  }

  const groups: Array<PortfolioGroup & { sortOrder: number; createdAtMs: number }> = [];

  for (const partition of partitions.values()) {
    const { portfolioId, portfolioName, portfolioSortOrder, portfolioCreatedAt } = partition[0];

    // The engine resolves transaction ordering internally (tradeDate asc,
    // createdAt asc, id asc) — the partition goes in raw, never pre-sorted or
    // pre-summed. One instrument's rows in → exactly one position out.
    const position = computePositions(partition, quotes, fxRates)[0];

    // Value guard chain, mirrored from `live-payload.ts`: usable quote (same
    // currency), rate present (PLN short-circuits to '1'), quantity > 0 —
    // otherwise null → '—', matching the combined card's degradation exactly.
    const quote = quotes.get(position.symbol);
    const usable = quote && quote.currency === position.currency ? quote : undefined;
    const rate = usable
      ? position.currency === 'PLN'
        ? '1'
        : fxRates.get(position.currency)
      : undefined;
    const valueDec =
      usable && rate !== undefined && position.quantity.greaterThan(0)
        ? position.quantity.times(dec(usable.price)).times(dec(rate))
        : null;

    // Percent against the PLN cost basis. `pctChange` returns null on a zero
    // basis and fmtPct renders it "—" — never +0.00%.
    const pct =
      position.unrealizedPLN === null
        ? null
        : pctChange(position.costBasisPLN, position.costBasisPLN.plus(position.unrealizedPLN));

    groups.push({
      portfolioId,
      portfolioName,
      sortOrder: portfolioSortOrder,
      createdAtMs: portfolioCreatedAt.getTime(),
      summary: {
        currency: position.currency,
        quantity: fmtQuantity(position.quantity),
        avgCost: position.avgCost === null ? null : fmtMoney(position.avgCost, position.currency),
        costBasisPLN: fmtMoney(position.costBasisPLN, 'PLN'),
        unrealizedPLN:
          position.unrealizedPLN === null ? null : signedMoney(position.unrealizedPLN, 'PLN'),
        unrealizedPct: fmtPct(pct),
        direction: directionOf(position.unrealizedPLN),
        valuePLN: valueDec === null ? null : fmtMoney(valueDec, 'PLN'),
        oversold: position.oversold,
      },
    });
  }

  // The user's own portfolio ordering, exactly what the Portfolios screen
  // renders; the name tie-break makes the order total (names are unique per
  // user by constraint), hence deterministic and testable.
  groups.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
    return a.portfolioName < b.portfolioName ? -1 : a.portfolioName > b.portfolioName ? 1 : 0;
  });

  return groups.map(({ portfolioId, portfolioName, summary }) => ({
    portfolioId,
    portfolioName,
    summary,
  }));
}
