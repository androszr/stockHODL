import type Decimal from 'decimal.js';

import { ZERO } from '@/lib/money';

/**
 * Where the money sits — one pure fold producing ALL FOUR dimensions at once.
 *
 * There is deliberately no country/domicile dimension: the market-data
 * provider exposes no domicile field (`address.country` is never populated and
 * `locale` means "listed on a US market", so every ticker would resolve to US),
 * and no second vendor is permitted. A dimension that renders 100 % US forever
 * is a confident wrong answer with nothing on screen looking missing, which is
 * strictly worse than the Unknown bucket.
 *
 * Computing every dimension in one pass is what lets the client switch tabs
 * with zero requests and zero recomputation: the payload already holds all
 * four folds. It is also what makes the slices agree by construction — every
 * dimension partitions the SAME set of priced holdings, so the per-portfolio
 * values sum to the per-ticker values sum to the total.
 *
 * Two doctrines, both inherited from `computePortfolioSummary`:
 *
 * - **Unpriceable is named, never zeroed.** `excludedSymbols` rides through
 *   untouched and the UI states that the percentages exclude them.
 * - **Unclassified is named, never folded.** A null sector lands
 *   in an explicit `__unknown` bucket labelled "Unknown" — never merged into
 *   a neighbouring slice, never dropped.
 */

export type AllocationDimension = 'ticker' | 'portfolio' | 'currency' | 'sector';

export const ALLOCATION_DIMENSIONS: readonly AllocationDimension[] = [
  'ticker',
  'portfolio',
  'currency',
  'sector',
];

/** The bucket every unclassifiable holding lands in — named, never hidden. */
export const UNKNOWN_KEY = '__unknown';
export const UNKNOWN_LABEL = 'Unknown';

/**
 * One priced holding IN ONE PORTFOLIO. The portfolio dimension is why this is
 * per (instrument, portfolio) and not per instrument: the same ticker held in
 * two portfolios is two rows, and summing them is the ticker dimension.
 */
export interface AllocationHolding {
  instrumentId: string;
  symbol: string;
  currency: string;
  portfolioId: string;
  portfolioName: string;
  /** Only `> 0` participates — a closed position holds nothing to allocate. */
  quantity: Decimal;
  valuePLN: Decimal;
}

/**
 * What the vendor backfill knows about an instrument. Sector only — the
 * provider has no domicile field, so there is nothing honest to put beside it.
 */
export interface InstrumentProfile {
  sector: string | null;
}

export interface AllocationSlice {
  key: string;
  label: string;
  valuePLN: Decimal;
  /** Percent of the priced total; null when the total is zero — never +0.00 %. */
  pct: Decimal | null;
}

export interface AllocationBreakdown {
  byDimension: Record<AllocationDimension, AllocationSlice[]>;
  /** Σ over priced, open holdings — the denominator every `pct` uses. */
  totalPLN: Decimal;
  /** Passed through from the summary, so one caption can name them. */
  excludedSymbols: string[];
}

interface Bucket {
  label: string;
  value: Decimal;
}

const HUNDRED = '100';

export function buildAllocation(
  holdings: readonly AllocationHolding[],
  profiles: ReadonlyMap<string, InstrumentProfile>,
  excludedSymbols: readonly string[],
): AllocationBreakdown {
  const open = holdings.filter((h) => h.quantity.greaterThan(0));

  const buckets: Record<AllocationDimension, Map<string, Bucket>> = {
    ticker: new Map(),
    portfolio: new Map(),
    currency: new Map(),
    sector: new Map(),
  };

  let totalPLN = ZERO;

  for (const holding of open) {
    totalPLN = totalPLN.plus(holding.valuePLN);
    const profile = profiles.get(holding.instrumentId);

    add(buckets.ticker, holding.symbol, holding.symbol, holding.valuePLN);
    add(buckets.portfolio, holding.portfolioId, holding.portfolioName, holding.valuePLN);
    add(buckets.currency, holding.currency, holding.currency, holding.valuePLN);
    addClassified(buckets.sector, profile?.sector ?? null, holding.valuePLN);
  }

  const byDimension = {} as Record<AllocationDimension, AllocationSlice[]>;
  for (const dimension of ALLOCATION_DIMENSIONS) {
    byDimension[dimension] = toSlices(buckets[dimension], totalPLN);
  }

  return { byDimension, totalPLN, excludedSymbols: [...excludedSymbols] };
}

function add(bucket: Map<string, Bucket>, key: string, label: string, value: Decimal): void {
  const existing = bucket.get(key);
  if (existing) {
    existing.value = existing.value.plus(value);
  } else {
    bucket.set(key, { label, value });
  }
}

/** A null classification is a BUCKET, not an omission. */
function addClassified(bucket: Map<string, Bucket>, raw: string | null, value: Decimal): void {
  if (raw === null || raw.trim() === '') {
    add(bucket, UNKNOWN_KEY, UNKNOWN_LABEL, value);
    return;
  }
  add(bucket, raw, raw, value);
}

function toSlices(bucket: Map<string, Bucket>, total: Decimal): AllocationSlice[] {
  const slices: AllocationSlice[] = [];
  for (const [key, { label, value }] of bucket) {
    slices.push({
      key,
      label,
      valuePLN: value,
      // Guarded: a zero total yields null, which renders "—". A percentage of
      // nothing must never appear as +0,00 %.
      pct: total.isZero() ? null : value.div(total).times(HUNDRED),
    });
  }
  // Descending by value; label ascending breaks ties, so the order is stable
  // across renders rather than dependent on insertion.
  return slices.sort((a, b) => {
    const byValue = b.valuePLN.comparedTo(a.valuePLN);
    return byValue !== 0 ? byValue : a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}
