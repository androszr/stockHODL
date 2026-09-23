import type { Direction } from '@/lib/money';

/**
 * Shared display-row types for holdings surfaces. Pure types, importable from
 * server loaders — extracted from the web card when the card stopped
 * rendering transactions (M5: the rows moved to the instrument screen).
 */

/** One pre-formatted transaction row — every numeric is a display string. */
export interface HoldingTransactionRow {
  id: string;
  /** Plain 'YYYY-MM-DD'. */
  tradeDate: string;
  side: 'buy' | 'sell';
  quantity: string;
  price: string;
  fees: string;
  fxRate: string;
  portfolioName: string;
}

/**
 * The six-cell figure set (avg cost, cost basis PLN, unrealized PLN/pct,
 * value PLN, oversold). Every value is a pre-formatted display string built
 * server-side; direction comes from `directionOf()`.
 *
 * Moved here off the deleted web component so `/api/mobile/v1/instrument`
 * and `computePortfolioGroups` keep the same shape. `positionFiguresSchema`
 * in `src/lib/api/contracts/instrument.ts` mirrors this — do not change the
 * wire independently.
 */
export interface HoldingDetailData {
  /** Instrument trading currency, for the avg-cost label. */
  currency: string;
  quantity: string;
  /** Null when quantity is zero (oversold-at-zero rows). */
  avgCost: string | null;
  costBasisPLN: string;
  /** Formatted PLN amount, '+'-signed on gains; null without quote + rate. */
  unrealizedPLN: string | null;
  /** fmtPct output — already '—' when the percentage is undefined. */
  unrealizedPct: string;
  direction: Direction;
  /** Position market value in PLN; null without a usable quote + FX rate. */
  valuePLN: string | null;
  oversold: boolean;
}
