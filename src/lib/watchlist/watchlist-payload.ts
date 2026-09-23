import {
  proximityRank,
  targetGroupFor,
  targetStatusFor,
  type TargetLine,
} from '@/lib/alerts/target-proximity';
import type { TargetStatusContract } from '@/lib/api/contracts/price-targets';
import type { TargetGroupContract } from '@/lib/api/contracts/watchlist';
import {
  quoteFigures,
  type HoldingQuote,
  type LiveMarket,
  type QuoteFigures,
} from '@/lib/holdings/live-payload';
import type { MarketSessionInfo } from '@/lib/market-data/provider';

/**
 * Pure payload composition for the Watchlist — isomorphic like
 * `live-payload.ts`: no `server-only`, no DB, no fetch. Every figure is a
 * pre-formatted display string built through `quoteFigures` (the exact
 * mapping the Holdings tiles use: currency guard, `dec()`/`fmtPct`/
 * `directionOf`, '—' over fake zeros) — Decimal never crosses the client
 * boundary (non-negotiable #1).
 *
 * Deliberately a PARALLEL payload, not a widened `LivePayload`: watched
 * symbols never enter the Holdings walk, so the Holdings/Dashboard payload
 * and their vendor batch stay byte-identical to before this feature.
 */

/** The static identity a watch row carries into a composition. */
export interface WatchItemInput {
  instrumentId: string;
  /** Provider symbol — the quotes-map key. */
  symbol: string;
  /** Instrument trading currency, for the quote guard. */
  currency: string;
}

/** Everything a watchlist composition needs besides the quotes map. */
export interface WatchlistInputs {
  market: MarketSessionInfo;
  hasPollableSymbols: boolean;
  /** This user's target lines, keyed by instrument id — loaded once per
   *  walk beside the quotes, so the grouping and the figures can never
   *  disagree about which tick they describe. */
  targetsByInstrument: ReadonlyMap<string, TargetLine[]>;
}

/** One tile's live half: figures only — identity ships with the page. */
export interface LiveWatchItem extends QuoteFigures {
  instrumentId: string;
  /** Which section this item files under — the server's verdict, rendered
   *  as-is on the phone. */
  targetGroup: TargetGroupContract;
  /** The tile marker's readout; null when there is nothing to mark. */
  target: TargetStatusContract | null;
}

export interface WatchlistPayload {
  market: LiveMarket;
  /** SERVER-SORTED: `near` → `set` → `none`, ascending distance within
   *  `near`/`set` (unpriced `set` after priced), insertion order inside
   *  `none` and as every tie-break — see `watchlistPayloadSchema`. */
  items: LiveWatchItem[];
  /** Structural poll-gate verdict — same contract as `LivePayload`'s. */
  hasPollableSymbols: boolean;
}

const GROUP_ORDER: Record<TargetGroupContract, number> = { near: 0, set: 1, none: 2 };

export function composeWatchlistPayload(
  items: readonly WatchItemInput[],
  inputs: WatchlistInputs,
  quotes: ReadonlyMap<string, HoldingQuote>,
): WatchlistPayload {
  const ranked = items.map((item) => {
    const quote = quotes.get(item.symbol);
    // The same currency guard `quoteFigures` applies: a wrong-currency quote
    // is not a smaller number, and a distance measured from it would be a
    // lie beside figures that dashed out.
    const usable = quote && quote.currency === item.currency ? quote : undefined;
    const lines = inputs.targetsByInstrument.get(item.instrumentId) ?? [];
    const target = targetStatusFor(lines, usable?.price ?? null, item.currency);
    return {
      item: {
        instrumentId: item.instrumentId,
        ...quoteFigures(quote, item.currency),
        targetGroup: targetGroupFor(target),
        target,
      },
      // The Decimal sort key stays server-side; only formatted strings enter
      // `items` (non-negotiable #1).
      rank: proximityRank(lines, usable?.price ?? null),
    };
  });

  // `Array.prototype.sort` is stable, so insertion order is the tie-break
  // and the entire ordering of `none`. Null ranks (unpriced `set`, and all
  // of `none`) sort after priced ones within a group.
  ranked.sort((a, b) => {
    const byGroup = GROUP_ORDER[a.item.targetGroup] - GROUP_ORDER[b.item.targetGroup];
    if (byGroup !== 0) return byGroup;
    if (a.rank === null && b.rank === null) return 0;
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank.cmp(b.rank);
  });

  return {
    market: { ...inputs.market, serverNowMs: Date.now() },
    items: ranked.map((r) => r.item),
    hasPollableSymbols: inputs.hasPollableSymbols,
  };
}
