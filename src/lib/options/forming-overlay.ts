import { dec } from '@/lib/money';

import type { OptionValuationRow } from './value-series';

/**
 * True only when every ticker already has a row on `todayISO`. The book-wide
 * vendor skip uses this so one ticker with today cannot suppress overlay
 * for the rest — same gate as the portfolio closes patch.
 */
export function everyTickerHasToday(
  tickers: readonly string[],
  existingAsOf: Iterable<{ ticker: string; asOf: string }>,
  todayISO: string,
): boolean {
  if (tickers.length === 0) return true;
  const withToday = new Set<string>();
  for (const row of existingAsOf) {
    if (row.asOf === todayISO) withToday.add(row.ticker);
  }
  return tickers.every((ticker) => withToday.has(ticker));
}

/**
 * The price the live option cards would show for overlay: model mark when
 * present, else a non-degenerate snapshot last. A degenerate snapshot
 * (`prevClose === price`) is the rolled "no trade this session" pair — cards
 * then prefer a bar, so overlay must not plot that forming print.
 */
export function optionCardOverlayPrice(input: {
  mark?: string;
  snapshotPrice?: string;
  snapshotPrevClose?: string | null;
}): string | null {
  if (input.mark !== undefined) return dec(input.mark).toString();
  const price = input.snapshotPrice;
  if (price === undefined) return null;
  const prev = input.snapshotPrevClose;
  if (prev !== null && prev !== undefined && dec(prev).equals(dec(price))) return null;
  return dec(price).toString();
}

/**
 * In-memory mark rows for today's still-forming session. Pure — no I/O, no
 * `server-only`. Prices cross `dec()`; tickers already valued on `todayISO`
 * in marks or closes are skipped so merge cannot double the day.
 */
export function optionOverlayRows(input: {
  todayISO: string;
  liveByTicker: ReadonlyMap<string, string>;
  existingAsOf: Iterable<{ ticker: string; asOf: string }>;
}): OptionValuationRow[] {
  const already = new Set<string>();
  for (const row of input.existingAsOf) {
    if (row.asOf === input.todayISO) already.add(row.ticker);
  }

  const rows: OptionValuationRow[] = [];
  for (const [ticker, price] of input.liveByTicker) {
    if (already.has(ticker)) continue;
    rows.push({ ticker, asOf: input.todayISO, price: dec(price).toString() });
  }
  return rows;
}
