import { pctChange, type Money } from '@/lib/money';

/**
 * The 5%-in-12h price-move alert's window math — pure, Decimal-based, no I/O.
 * The caller supplies bar closes already fetched from
 * `QuoteProvider.getAggregates` for the trailing window; this module never
 * touches the vendor or the database.
 */

export interface WindowMoves {
  /** Percentage from the window's LOW to the latest close — positive or null. */
  upPct: Money | null;
  /** Percentage from the window's HIGH to the latest close — negative, zero, or null. */
  downPct: Money | null;
}

/**
 * Given a symbol's bar closes inside a trailing window, oldest first: the
 * largest up-move (window low → latest close) and the largest down-move
 * (window high → latest close), the same "since the extreme" framing Yahoo's
 * own alerts use. Fewer than two closes means there is no window to measure —
 * both come back null, never a fabricated 0%, matching `pctChange`'s own
 * null-on-undefined contract.
 */
export function computeWindowMoves(closes: readonly Money[]): WindowMoves {
  if (closes.length < 2) return { upPct: null, downPct: null };

  const latest = closes[closes.length - 1];
  let low = closes[0];
  let high = closes[0];
  for (const close of closes) {
    if (close.lt(low)) low = close;
    if (close.gt(high)) high = close;
  }

  return {
    upPct: pctChange(low, latest),
    downPct: pctChange(high, latest),
  };
}
